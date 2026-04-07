# route_backend_foundry_chat.py

import base64
import logging
import mimetypes

from config import *
from functions_appinsights import log_event
from functions_authentication import login_required, user_required, get_current_user_id
from functions_settings import get_settings
from swagger_wrapper import swagger_route, get_auth_security

logger = logging.getLogger(__name__)

# Maximum character length for a single base64-encoded attachment to prevent abuse
# 20 MB (base64 is ~4/3 of raw binary, so this covers ~15 MB raw files)
_MAX_ATTACHMENT_BASE64_LEN = 20 * 1024 * 1024  # 20 MB encoded

# Maximum number of attachments accepted per request (matches the JS front end)
_MAX_ATTACHMENTS = 5

# Maximum plain-text characters extracted from a non-image file before truncation
_MAX_TEXT_ATTACHMENT_CHARS = 30_000

# Supported image MIME types that Azure OpenAI vision accepts
_IMAGE_MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
}


def _build_openai_client(user_cfg: dict, settings: dict):
    """Return an (AzureOpenAI client, deployment_name) tuple.

    Priority order:
      1. User-supplied endpoint + deployment from the request payload.
      2. App-level Azure OpenAI settings (key or managed-identity auth).
    """
    endpoint   = (user_cfg.get("endpoint") or "").strip()
    deployment = (user_cfg.get("deployment") or "").strip()
    api_key    = (user_cfg.get("api_key") or "").strip()
    api_version = (user_cfg.get("api_version") or "").strip() or "2024-10-21"

    if endpoint and deployment:
        # User explicitly provided connection details
        if api_key:
            client = AzureOpenAI(
                azure_endpoint=endpoint,
                api_key=api_key,
                api_version=api_version,
            )
        else:
            # Attempt managed-identity / default credential
            token_provider = get_bearer_token_provider(
                DefaultAzureCredential(), cognitive_services_scope
            )
            client = AzureOpenAI(
                azure_endpoint=endpoint,
                azure_ad_token_provider=token_provider,
                api_version=api_version,
            )
        return client, deployment

    # Fall back to app-level settings
    auth_type   = settings.get("azure_openai_gpt_authentication_type", "key")
    app_endpoint = settings.get("azure_openai_gpt_endpoint", "")
    app_version  = settings.get("azure_openai_gpt_api_version", "2024-10-21")

    gpt_model_obj = settings.get("gpt_model", {})
    if gpt_model_obj and gpt_model_obj.get("selected"):
        app_deployment = gpt_model_obj["selected"][0].get("deploymentName", "")
    else:
        app_deployment = settings.get("azure_openai_gpt_deployment", "")

    if not app_endpoint or not app_deployment:
        raise ValueError(
            "Azure OpenAI endpoint and deployment are not configured. "
            "Enter them in Settings or ask your administrator to configure the app."
        )

    if auth_type == "managed_identity":
        token_provider = get_bearer_token_provider(
            DefaultAzureCredential(), cognitive_services_scope
        )
        client = AzureOpenAI(
            azure_endpoint=app_endpoint,
            azure_ad_token_provider=token_provider,
            api_version=app_version,
        )
    else:
        app_key = settings.get("azure_openai_gpt_key", "")
        if not app_key:
            raise ValueError(
                "Azure OpenAI API key is not configured. "
                "Enter it in Settings or ask your administrator."
            )
        client = AzureOpenAI(
            azure_endpoint=app_endpoint,
            api_key=app_key,
            api_version=app_version,
        )

    return client, app_deployment


def _build_messages(system_prompt: str, history: list, user_text: str, attachments: list) -> list:
    """Construct the messages list for the chat completion call.

    Attachments that are images are sent as vision content blocks.
    Non-image attachments are concatenated as text.
    """
    messages = []

    # System message
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})

    # Conversation history (trimmed, already validated by caller)
    for entry in history:
        role = entry.get("role", "")
        content = entry.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    # Current user turn — potentially multi-part (text + images)
    user_content_parts = []

    # Inline image attachments (vision)
    image_attachments = [a for a in attachments if a.get("type", "") in _IMAGE_MIME_TYPES]
    text_attachments  = [a for a in attachments if a.get("type", "") not in _IMAGE_MIME_TYPES]

    for img in image_attachments:
        raw_b64 = img.get("base64", "")
        # The JS sends a data-URL like "data:image/png;base64,<data>"
        if "," in raw_b64:
            raw_b64 = raw_b64.split(",", 1)[1]
        mime = img.get("type", "image/png")
        user_content_parts.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{mime};base64,{raw_b64}",
                "detail": "auto",
            },
        })

    # Prepend extracted text from non-image files to the user message
    extra_text_parts = []
    for doc in text_attachments:
        name = doc.get("name", "attachment")
        raw_b64 = doc.get("base64", "")
        if "," in raw_b64:
            raw_b64 = raw_b64.split(",", 1)[1]
        try:
            decoded = base64.b64decode(raw_b64).decode("utf-8", errors="replace")
            # Truncate very large text files to avoid token overflow
            if len(decoded) > _MAX_TEXT_ATTACHMENT_CHARS:
                decoded = decoded[:_MAX_TEXT_ATTACHMENT_CHARS] + "\n\n[... file truncated ...]"
            extra_text_parts.append(f"[Attached file: {name}]\n{decoded}")
        except Exception:
            extra_text_parts.append(f"[Attached file: {name}] (binary content, not displayable as text)")

    # Combine text
    full_text = "\n\n".join(filter(None, extra_text_parts + [user_text]))

    if user_content_parts:
        # Multi-part message (text + images)
        if full_text:
            user_content_parts.insert(0, {"type": "text", "text": full_text})
        messages.append({"role": "user", "content": user_content_parts})
    else:
        messages.append({"role": "user", "content": full_text})

    return messages


def register_route_backend_foundry_chat(app):
    @app.route('/api/foundry-chat', methods=['POST'])
    @swagger_route(security=get_auth_security())
    @login_required
    @user_required
    def foundry_chat_api():
        user_id = get_current_user_id()
        if not user_id:
            return jsonify({'error': 'User not authenticated'}), 401

        data = request.get_json(silent=True) or {}

        mode            = (data.get("mode") or "backend").strip()
        user_text       = (data.get("message") or "").strip()
        system_prompt   = (data.get("system_prompt") or "You are a helpful AI assistant.").strip()
        max_tokens      = int(data.get("max_tokens") or 2048)
        history         = data.get("history") or []
        raw_attachments = data.get("attachments") or []

        if not user_text and not raw_attachments:
            return jsonify({'error': 'Message is required'}), 400

        # Cap history length to avoid excessive token usage
        history = history[-20:] if len(history) > 20 else history

        # Validate attachments size
        validated_attachments = []
        for att in raw_attachments[:_MAX_ATTACHMENTS]:
            b64 = att.get("base64", "")
            if len(b64) > _MAX_ATTACHMENT_BASE64_LEN:
                return jsonify({'error': f'Attachment "{att.get("name", "")}" exceeds maximum size.'}), 400
            validated_attachments.append(att)

        settings = get_settings()

        try:
            if mode == "foundry":
                # ── Foundry Agent mode ────────────────────────────────────────────
                from semantic_kernel.contents.chat_message_content import ChatMessageContent
                from semantic_kernel.contents.utils.author_role import AuthorRole
                from foundry_agent_runtime import execute_foundry_agent, FoundryAgentInvocationError

                agent_id = (data.get("agent_id") or "").strip()
                endpoint = (data.get("endpoint") or "").strip()

                if not agent_id:
                    return jsonify({'error': 'agent_id is required for Foundry mode.'}), 400

                foundry_settings = {}
                if agent_id:
                    foundry_settings["agent_id"] = agent_id
                if endpoint:
                    foundry_settings["endpoint"] = endpoint

                # Build history as ChatMessageContent list
                message_history = []
                for entry in history:
                    role = entry.get("role", "")
                    content = entry.get("content", "")
                    if not role or not content:
                        continue
                    if role == "user":
                        message_history.append(
                            ChatMessageContent(role=AuthorRole.USER, content=content)
                        )
                    elif role == "assistant":
                        message_history.append(
                            ChatMessageContent(role=AuthorRole.ASSISTANT, content=content)
                        )

                # Add current user message
                message_history.append(
                    ChatMessageContent(role=AuthorRole.USER, content=user_text)
                )

                import asyncio
                result = asyncio.run(
                    execute_foundry_agent(
                        foundry_settings=foundry_settings,
                        global_settings=settings,
                        message_history=message_history,
                        metadata={"user_id": user_id},
                    )
                )

                log_event(
                    "[FoundryChat] Foundry agent response sent",
                    extra={"user_id": user_id, "mode": mode},
                )
                return jsonify({"reply": result.message})

            else:
                # ── Direct Azure OpenAI mode (default / backend) ──────────────────
                user_cfg = {
                    "endpoint":    data.get("endpoint",    ""),
                    "deployment":  data.get("deployment",  ""),
                    "api_key":     data.get("api_key",     ""),
                    "api_version": data.get("api_version", ""),
                }

                client, deployment = _build_openai_client(user_cfg, settings)
                messages = _build_messages(system_prompt, history, user_text, validated_attachments)

                response = client.chat.completions.create(
                    model=deployment,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=0.7,
                )

                reply = response.choices[0].message.content or ""

                log_event(
                    "[FoundryChat] OpenAI response sent",
                    extra={
                        "user_id": user_id,
                        "mode": mode,
                        "deployment": deployment,
                        "prompt_tokens": getattr(response.usage, "prompt_tokens", 0),
                        "completion_tokens": getattr(response.usage, "completion_tokens", 0),
                    },
                )
                return jsonify({"reply": reply})

        except ValueError as ve:
            log_event(
                "[FoundryChat] Configuration error",
                extra={"user_id": user_id, "error": str(ve)},
                level=logging.WARNING,
            )
            return jsonify({'error': str(ve)}), 400
        except Exception as exc:
            log_event(
                "[FoundryChat] Unexpected error",
                extra={"user_id": user_id, "error": str(exc)},
                level=logging.ERROR,
            )
            return jsonify({'error': 'An unexpected error occurred. Please try again.'}), 500
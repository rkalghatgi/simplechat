// foundry_chat.js

// =========================================================
// Foundry Chat — standalone modern chat UI
// =========================================================

(function () {
    "use strict";

    // ── Constants ─────────────────────────────────────────
    const MAX_ATTACHMENTS        = 5;
    const MAX_ATTACHMENT_B64_LEN = 20 * 1024 * 1024; // 20 MB base64 limit
    const MAX_HISTORY_ENTRIES    = 20;

    // ── DOM references ────────────────────────────────────
    const shell           = document.getElementById("fc-shell");
    const messagesEl      = document.getElementById("fc-messages");
    const welcomeEl       = document.getElementById("fc-welcome");
    const typingEl        = document.getElementById("fc-typing");
    const textareaEl      = document.getElementById("fc-message-input");
    const sendBtn         = document.getElementById("fc-send-btn");
    const fileInput       = document.getElementById("fc-file-input");
    const imageInput      = document.getElementById("fc-image-input");
    const filePreview     = document.getElementById("fc-file-preview");
    const errorBanner     = document.getElementById("fc-error-banner");
    const errorBannerText = document.getElementById("fc-error-banner-text");
    const logoWrapper     = document.getElementById("fc-logo-wrapper");
    const logoImg         = document.getElementById("fc-logo-img");
    const logoPlaceholder = document.getElementById("fc-logo-placeholder");
    const logoInput       = document.getElementById("fc-logo-input");
    const statusDot       = document.getElementById("fc-status-dot");
    const statusText      = document.getElementById("fc-status-text");
    const themeToggleBtn  = document.getElementById("fc-theme-btn");
    const settingsBtn     = document.getElementById("fc-settings-btn");
    const settingsOverlay = document.getElementById("fc-settings-overlay");
    const settingsClose   = document.getElementById("fc-settings-close");
    const newChatBtn      = document.getElementById("fc-new-chat-btn");
    const toastContainer  = document.getElementById("fc-toast-container");
    const fcTitle         = document.getElementById("fc-title");

    // Settings inputs
    const settingEndpoint   = document.getElementById("fc-setting-endpoint");
    const settingDeployment = document.getElementById("fc-setting-deployment");
    const settingApiKey     = document.getElementById("fc-setting-api-key");
    const settingApiVersion = document.getElementById("fc-setting-api-version");
    const settingAgentId    = document.getElementById("fc-setting-agent-id");
    const settingMode       = document.getElementById("fc-setting-mode");
    const settingMaxTokens  = document.getElementById("fc-setting-max-tokens");
    const settingSystemPrompt = document.getElementById("fc-setting-system-prompt");
    const settingChatTitle  = document.getElementById("fc-setting-title");
    const settingsSaveBtn   = document.getElementById("fc-settings-save");

    // ── State ─────────────────────────────────────────────
    let pendingFiles = [];    // { name, type, base64, previewUrl }
    let messageHistory = [];  // { role, content }
    let isStreaming = false;
    let currentTheme = "dark";
    let config = {};
    // Note: sessionApiKey is held only in memory (never persisted to localStorage)
    // so the user must re-enter it each session, keeping credentials out of storage.
    let sessionApiKey = "";

    // ── Storage keys ──────────────────────────────────────
    const STORAGE_CONFIG = "fc_config_v2";
    const STORAGE_LOGO   = "fc_logo_v1";
    const STORAGE_THEME  = "fc_theme_v1";

    // ── Init ──────────────────────────────────────────────
    function init() {
        loadTheme();
        loadConfig();
        loadLogo();
        bindEvents();
        adjustTextareaHeight();
        setStatus("ready", "Ready");
    }

    // ── Theme ─────────────────────────────────────────────
    function loadTheme() {
        currentTheme = localStorage.getItem(STORAGE_THEME) || "dark";
        applyTheme(currentTheme);
    }

    function applyTheme(theme) {
        currentTheme = theme;
        shell.setAttribute("data-fc-theme", theme === "light" ? "light" : "dark");
        document.documentElement.setAttribute("data-fc-theme", theme === "light" ? "light" : "dark");
        if (themeToggleBtn) {
            themeToggleBtn.innerHTML = theme === "light"
                ? '<i class="bi bi-moon-fill"></i>'
                : '<i class="bi bi-sun-fill"></i>';
            themeToggleBtn.title = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
        }
        localStorage.setItem(STORAGE_THEME, theme);
    }

    // ── Config ────────────────────────────────────────────
    const DEFAULT_CONFIG = {
        mode: "direct",           // "direct" | "foundry"
        endpoint: "",
        deployment: "",
        // apiKey is intentionally NOT stored here — it is kept in sessionApiKey (memory only)
        apiVersion: "2024-10-21",
        agentId: "",
        maxTokens: 2048,
        systemPrompt: "You are a helpful AI assistant.",
        chatTitle: "Foundry Chat",
    };

    function loadConfig() {
        try {
            const stored = localStorage.getItem(STORAGE_CONFIG);
            config = stored ? { ...DEFAULT_CONFIG, ...JSON.parse(stored) } : { ...DEFAULT_CONFIG };
        } catch {
            config = { ...DEFAULT_CONFIG };
        }
        syncSettingsForm();
        updateTitle();
    }

    function saveConfig() {
        localStorage.setItem(STORAGE_CONFIG, JSON.stringify(config));
        updateTitle();
    }

    function syncSettingsForm() {
        if (settingEndpoint)    settingEndpoint.value   = config.endpoint    || "";
        if (settingDeployment)  settingDeployment.value = config.deployment  || "";
        // API key is session-only — show blank if not yet entered this session
        if (settingApiKey)      settingApiKey.value     = sessionApiKey      || "";
        if (settingApiVersion)  settingApiVersion.value = config.apiVersion  || DEFAULT_CONFIG.apiVersion;
        if (settingAgentId)     settingAgentId.value    = config.agentId     || "";
        if (settingMode)        settingMode.value       = config.mode        || "direct";
        if (settingMaxTokens)   settingMaxTokens.value  = config.maxTokens   || DEFAULT_CONFIG.maxTokens;
        if (settingSystemPrompt) settingSystemPrompt.value = config.systemPrompt || DEFAULT_CONFIG.systemPrompt;
        if (settingChatTitle)   settingChatTitle.value  = config.chatTitle   || DEFAULT_CONFIG.chatTitle;
        toggleFoundryFields();
    }

    function toggleFoundryFields() {
        const mode = settingMode ? settingMode.value : "direct";
        const foundryFields = document.getElementById("fc-foundry-fields");
        const directFields  = document.getElementById("fc-direct-fields");
        if (foundryFields) foundryFields.classList.toggle("d-none", mode !== "foundry");
        if (directFields)  directFields.classList.toggle("d-none", mode === "foundry");
    }

    function updateTitle() {
        if (fcTitle) {
            const titleEl = fcTitle.querySelector("#fc-title-text");
            if (titleEl) titleEl.textContent = config.chatTitle || DEFAULT_CONFIG.chatTitle;
        }
    }

    // ── Logo ──────────────────────────────────────────────
    function loadLogo() {
        const stored = localStorage.getItem(STORAGE_LOGO);
        if (stored) {
            showLogo(stored);
        }
    }

    function showLogo(dataUrl) {
        if (logoImg)         { logoImg.src = dataUrl; logoImg.classList.remove("d-none"); }
        if (logoPlaceholder) { logoPlaceholder.classList.add("d-none"); }
    }

    function clearLogo() {
        localStorage.removeItem(STORAGE_LOGO);
        if (logoImg)         { logoImg.src = ""; logoImg.classList.add("d-none"); }
        if (logoPlaceholder) { logoPlaceholder.classList.remove("d-none"); }
        showToast("Logo removed", "info");
    }

    // ── Events ────────────────────────────────────────────
    function bindEvents() {
        // Theme toggle
        if (themeToggleBtn) {
            themeToggleBtn.addEventListener("click", () => {
                applyTheme(currentTheme === "dark" ? "light" : "dark");
            });
        }

        // Settings
        if (settingsBtn) settingsBtn.addEventListener("click", openSettings);
        if (settingsClose) settingsClose.addEventListener("click", closeSettings);
        if (settingsOverlay) {
            settingsOverlay.addEventListener("click", (e) => {
                if (e.target === settingsOverlay) closeSettings();
            });
        }
        if (settingsSaveBtn) settingsSaveBtn.addEventListener("click", onSettingsSave);
        if (settingMode)     settingMode.addEventListener("change", toggleFoundryFields);

        // New chat
        if (newChatBtn) newChatBtn.addEventListener("click", startNewChat);

        // Logo
        if (logoWrapper) {
            logoWrapper.addEventListener("click", () => {
                // Right-click or holding = remove; left click = upload
                logoInput.click();
            });
            logoWrapper.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                clearLogo();
            });
        }
        if (logoInput) {
            logoInput.addEventListener("change", onLogoChange);
        }

        // Textarea
        if (textareaEl) {
            textareaEl.addEventListener("input", adjustTextareaHeight);
            textareaEl.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            });
        }

        // Send button
        if (sendBtn) sendBtn.addEventListener("click", sendMessage);

        // File attach buttons
        const attachFileBtn  = document.getElementById("fc-attach-file-btn");
        const attachImageBtn = document.getElementById("fc-attach-image-btn");
        if (attachFileBtn)  attachFileBtn.addEventListener("click",  () => fileInput.click());
        if (attachImageBtn) attachImageBtn.addEventListener("click", () => imageInput.click());
        if (fileInput)  fileInput.addEventListener("change",  (e) => onFilesSelected(e.target.files));
        if (imageInput) imageInput.addEventListener("change", (e) => onFilesSelected(e.target.files, true));

        // Drag-and-drop on the input section
        const inputSection = document.getElementById("fc-input-section");
        if (inputSection) {
            inputSection.addEventListener("dragover",  (e) => { e.preventDefault(); inputSection.classList.add("fc-dragover"); });
            inputSection.addEventListener("dragleave", ()  => { inputSection.classList.remove("fc-dragover"); });
            inputSection.addEventListener("drop",      (e) => {
                e.preventDefault();
                inputSection.classList.remove("fc-dragover");
                if (e.dataTransfer.files.length) onFilesSelected(e.dataTransfer.files);
            });
        }

        // Welcome chips
        document.querySelectorAll(".fc-chip").forEach((chip) => {
            chip.addEventListener("click", () => {
                if (textareaEl) {
                    textareaEl.value = chip.textContent.trim();
                    textareaEl.focus();
                    adjustTextareaHeight();
                }
            });
        });
    }

    // ── Settings panel ────────────────────────────────────
    function openSettings() {
        if (settingsOverlay) settingsOverlay.classList.add("fc-open");
        syncSettingsForm();
    }

    function closeSettings() {
        if (settingsOverlay) settingsOverlay.classList.remove("fc-open");
    }

    function onSettingsSave() {
        config.mode         = settingMode        ? settingMode.value         : config.mode;
        config.endpoint     = settingEndpoint    ? settingEndpoint.value.trim()    : config.endpoint;
        config.deployment   = settingDeployment  ? settingDeployment.value.trim()  : config.deployment;
        // Store API key in memory only — not in localStorage — to avoid clear-text secret storage
        sessionApiKey       = settingApiKey      ? settingApiKey.value.trim()      : sessionApiKey;
        config.apiVersion   = settingApiVersion  ? settingApiVersion.value.trim()  : config.apiVersion;
        config.agentId      = settingAgentId     ? settingAgentId.value.trim()     : config.agentId;
        config.maxTokens    = settingMaxTokens   ? parseInt(settingMaxTokens.value, 10) || 2048 : config.maxTokens;
        config.systemPrompt = settingSystemPrompt ? settingSystemPrompt.value      : config.systemPrompt;
        config.chatTitle    = settingChatTitle   ? settingChatTitle.value.trim()   : config.chatTitle;
        saveConfig();
        closeSettings();
        showToast("Settings saved", "success");
        setStatus("ready", "Ready");
    }

    // ── Logo upload ───────────────────────────────────────
    function onLogoChange(e) {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            showToast("Please select an image file", "error");
            return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataUrl = ev.target.result;
            localStorage.setItem(STORAGE_LOGO, dataUrl);
            showLogo(dataUrl);
            showToast("Logo updated", "success");
        };
        reader.readAsDataURL(file);
        e.target.value = "";
    }

    // ── File handling ─────────────────────────────────────
    function onFilesSelected(files, isImage = false) {
        if (!files || !files.length) return;
        Array.from(files).forEach((file) => {
            if (pendingFiles.length >= MAX_ATTACHMENTS) {
                showToast(`Maximum ${MAX_ATTACHMENTS} attachments per message`, "error");
                return;
            }
            const reader = new FileReader();
            reader.onload = (ev) => {
                const base64 = ev.target.result; // data URL
                const entry = {
                    name: file.name,
                    type: file.type,
                    base64: base64,
                    previewUrl: file.type.startsWith("image/") ? base64 : null,
                };
                pendingFiles.push(entry);
                renderFilePreview();
            };
            reader.readAsDataURL(file);
        });
        // Reset input so same file can be re-selected
        if (fileInput)  fileInput.value = "";
        if (imageInput) imageInput.value = "";
    }

    function renderFilePreview() {
        if (!filePreview) return;
        filePreview.innerHTML = "";
        pendingFiles.forEach((f, idx) => {
            const chip = document.createElement("div");
            chip.className = "fc-file-chip";

            if (f.previewUrl) {
                const img = document.createElement("img");
                img.src = f.previewUrl;
                chip.appendChild(img);
            } else {
                const icon = document.createElement("i");
                icon.className = "bi bi-file-earmark-text";
                chip.appendChild(icon);
            }

            const name = document.createElement("span");
            name.textContent = truncateFilename(f.name, 20);
            chip.appendChild(name);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "fc-file-chip-remove";
            remove.innerHTML = '<i class="bi bi-x"></i>';
            remove.addEventListener("click", () => {
                pendingFiles.splice(idx, 1);
                renderFilePreview();
            });
            chip.appendChild(remove);
            filePreview.appendChild(chip);
        });
    }

    function truncateFilename(name, max) {
        if (name.length <= max) return name;
        const ext = name.lastIndexOf(".");
        const extPart = ext > 0 ? name.slice(ext) : "";
        return name.slice(0, max - extPart.length - 3) + "..." + extPart;
    }

    // ── Textarea auto-height ─────────────────────────────
    function adjustTextareaHeight() {
        if (!textareaEl) return;
        textareaEl.style.height = "auto";
        textareaEl.style.height = Math.min(textareaEl.scrollHeight, 180) + "px";
    }

    // ── Send message ──────────────────────────────────────
    async function sendMessage() {
        if (isStreaming) return;

        const text = textareaEl ? textareaEl.value.trim() : "";
        if (!text && pendingFiles.length === 0) return;

        // Hide welcome, show messages
        if (welcomeEl) welcomeEl.classList.add("fc-hidden");

        // Build display content
        appendUserMessage(text, pendingFiles);

        // Build API payload
        const attachments = [...pendingFiles];
        pendingFiles = [];
        renderFilePreview();
        if (textareaEl) { textareaEl.value = ""; adjustTextareaHeight(); }
        if (sendBtn) sendBtn.disabled = true;

        showTyping();
        hideError();

        try {
            const reply = await callBackend(text, attachments);
            hideTyping();
            appendAiMessage(reply);
            setStatus("connected", "Connected");
        } catch (err) {
            hideTyping();
            showError(err.message || "An error occurred. Check your settings and try again.");
            setStatus("error", "Error");
        } finally {
            isStreaming = false;
            if (sendBtn) sendBtn.disabled = false;
            if (textareaEl) textareaEl.focus();
        }
    }

    // ── Call backend ──────────────────────────────────────
    async function callBackend(text, attachments) {
        const payload = {
            message: text,
            mode: config.mode,
            endpoint: config.endpoint,
            deployment: config.deployment,
            api_key: sessionApiKey,
            api_version: config.apiVersion,
            agent_id: config.agentId,
            max_tokens: config.maxTokens,
            system_prompt: config.systemPrompt,
            history: messageHistory.slice(-MAX_HISTORY_ENTRIES),
            attachments: attachments.map((a) => ({
                name: a.name,
                type: a.type,
                base64: a.base64,
            })),
        };

        const response = await fetch("/api/foundry-chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            let errMsg = `Server error ${response.status}`;
            try {
                const errData = await response.json();
                errMsg = errData.error || errMsg;
            } catch {}
            throw new Error(errMsg);
        }

        const data = await response.json();
        if (data.error) throw new Error(data.error);

        // Update history
        messageHistory.push({ role: "user", content: text });
        messageHistory.push({ role: "assistant", content: data.reply });

        return data.reply;
    }

    // ── Render messages ───────────────────────────────────
    function appendUserMessage(text, files) {
        const wrapper = document.createElement("div");
        wrapper.className = "fc-message fc-user";

        const avatar = document.createElement("div");
        avatar.className = "fc-avatar";
        avatar.innerHTML = '<i class="bi bi-person-fill"></i>';

        const bubble = document.createElement("div");
        bubble.className = "fc-bubble";

        // Attachments first
        files.forEach((f) => {
            if (f.previewUrl) {
                const img = document.createElement("img");
                img.src = f.previewUrl;
                img.className = "fc-msg-image";
                img.alt = f.name;
                bubble.appendChild(img);
            } else {
                const att = document.createElement("div");
                att.className = "fc-attachment";
                att.innerHTML = `<i class="bi bi-file-earmark-text"></i> ${escapeHtml(f.name)}`;
                bubble.appendChild(att);
            }
        });

        if (text) {
            const p = document.createElement("p");
            p.textContent = text;
            bubble.appendChild(p);
        }

        const meta = document.createElement("div");
        meta.className = "fc-msg-meta";

        const timeEl = document.createElement("span");
        timeEl.className = "fc-msg-time";
        timeEl.textContent = formatTime(new Date());
        meta.appendChild(timeEl);

        const msgContainer = document.createElement("div");
        msgContainer.appendChild(bubble);
        msgContainer.appendChild(meta);

        wrapper.appendChild(msgContainer);
        wrapper.appendChild(avatar);
        messagesEl.appendChild(wrapper);
        scrollToBottom();
    }

    function appendAiMessage(markdownText) {
        const wrapper = document.createElement("div");
        wrapper.className = "fc-message fc-ai";

        const avatar = document.createElement("div");
        avatar.className = "fc-avatar";
        avatar.innerHTML = '<i class="bi bi-stars"></i>';

        const bubble = document.createElement("div");
        bubble.className = "fc-bubble";
        bubble.innerHTML = renderMarkdown(markdownText);

        const meta = document.createElement("div");
        meta.className = "fc-msg-meta";

        const timeEl = document.createElement("span");
        timeEl.className = "fc-msg-time";
        timeEl.textContent = formatTime(new Date());

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "fc-copy-btn";
        copyBtn.title = "Copy response";
        copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
        copyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(markdownText).then(() => {
                copyBtn.innerHTML = '<i class="bi bi-clipboard-check"></i>';
                setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1500);
            });
        });

        meta.appendChild(timeEl);
        meta.appendChild(copyBtn);

        const msgContainer = document.createElement("div");
        msgContainer.appendChild(bubble);
        msgContainer.appendChild(meta);

        wrapper.appendChild(avatar);
        wrapper.appendChild(msgContainer);
        messagesEl.appendChild(wrapper);

        // Apply syntax highlighting if Prism is loaded
        if (window.Prism) {
            bubble.querySelectorAll("pre code[class]").forEach((el) => Prism.highlightElement(el));
        }

        scrollToBottom();
    }

    // ── Markdown renderer ────────────────────────────────
    function renderMarkdown(text) {
        // Use marked.js if available, otherwise basic rendering
        if (window.marked) {
            try {
                return window.marked.parse(text, { breaks: true, gfm: true });
            } catch {}
        }
        // Minimal fallback
        return escapeHtml(text)
            .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/\*(.+?)\*/g, "<em>$1</em>")
            .replace(/\n/g, "<br>");
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // ── Typing indicator ─────────────────────────────────
    function showTyping() {
        if (typingEl) typingEl.classList.add("fc-visible");
        scrollToBottom();
    }

    function hideTyping() {
        if (typingEl) typingEl.classList.remove("fc-visible");
    }

    // ── Error banner ──────────────────────────────────────
    function showError(msg) {
        if (errorBanner && errorBannerText) {
            errorBannerText.textContent = msg;
            errorBanner.classList.add("fc-visible");
        }
        showToast(msg, "error");
    }

    function hideError() {
        if (errorBanner) errorBanner.classList.remove("fc-visible");
    }

    // ── Status indicator ──────────────────────────────────
    function setStatus(state, label) {
        if (statusDot) {
            statusDot.className = ""; // reset
            if (state === "connected") statusDot.classList.add("fc-connected");
            if (state === "error")     statusDot.classList.add("fc-error");
        }
        if (statusText) statusText.textContent = label;
    }

    // ── Toast ─────────────────────────────────────────────
    function showToast(msg, type = "info") {
        if (!toastContainer) return;
        const toast = document.createElement("div");
        toast.className = `fc-toast fc-toast-${type}`;
        toast.textContent = msg;
        toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = "0";
            toast.style.transition = "opacity 0.3s";
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ── New chat ─────────────────────────────────────────
    function startNewChat() {
        messageHistory = [];
        if (messagesEl) {
            // Remove all message nodes
            const children = Array.from(messagesEl.children);
            children.forEach((c) => {
                if (c.id !== "fc-typing" && c.id !== "fc-welcome") {
                    c.remove();
                }
            });
        }
        if (welcomeEl) welcomeEl.classList.remove("fc-hidden");
        hideError();
        if (textareaEl) { textareaEl.value = ""; adjustTextareaHeight(); textareaEl.focus(); }
        pendingFiles = [];
        renderFilePreview();
        setStatus("ready", "Ready");
    }

    // ── Scroll helpers ────────────────────────────────────
    function scrollToBottom() {
        if (!messagesEl) return;
        requestAnimationFrame(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    // ── Date/time ────────────────────────────────────────
    function formatTime(date) {
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    // ── Bootstrap Tooltip init ────────────────────────────
    function initTooltips() {
        if (typeof bootstrap !== "undefined" && bootstrap.Tooltip) {
            document.querySelectorAll("[title]").forEach((el) => {
                new bootstrap.Tooltip(el, { trigger: "hover" });
            });
        }
    }

    // ── Start ─────────────────────────────────────────────
    document.addEventListener("DOMContentLoaded", () => {
        init();
        initTooltips();
    });
})();

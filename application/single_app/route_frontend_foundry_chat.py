# route_frontend_foundry_chat.py

import logging
from config import *
from functions_authentication import *
from functions_settings import *
from functions_appinsights import log_event
from swagger_wrapper import swagger_route, get_auth_security

logger = logging.getLogger(__name__)


def register_route_frontend_foundry_chat(app):
    @app.route('/foundry-chat', methods=['GET'])
    @swagger_route(security=get_auth_security())
    @login_required
    @user_required
    def foundry_chat():
        user_id = get_current_user_id()
        if not user_id:
            return redirect(url_for('login'))

        settings = get_settings()
        public_settings = sanitize_settings_for_user(settings)
        user_settings = get_user_settings(user_id)

        log_event(
            "[FoundryChat] Page accessed",
            extra={"user_id": user_id},
            level=logging.INFO,
        )

        return render_template(
            'foundry_chat.html',
            app_settings=public_settings,
            settings=public_settings,
            user_settings=user_settings,
        )

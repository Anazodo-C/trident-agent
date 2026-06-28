from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
import logging

logger = logging.getLogger(__name__)


class AuthMiddleware(BaseHTTPMiddleware):
    """
    Lightweight passthrough middleware.
    x402 payment auth is handled by the Node.js gateway (port 3001).
    This middleware is a hook for future JWT/API-key auth on admin endpoints.
    """

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        return response

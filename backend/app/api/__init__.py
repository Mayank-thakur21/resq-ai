"""HTTP API: ``api_router`` mounts every route module under the ``/api`` prefix.

Every public feature router gets the default rate limit (``RATE_LIMIT_DEFAULT``). Two are
deliberately exempt:

* ``health`` — container health checks poll it;
* ``users`` — internal (``X-Internal-Key``) and called only by the Next.js server, so a
  per-IP default bucket would be one bucket for *every* sign-in of the deployment (anyone
  could lock out all logins with ~2 bad requests per second). ``app.api.routes.users``
  applies its own per-end-client and per-account limits instead.
"""

from fastapi import APIRouter, Depends

from app.api.routes import (
    alerts,
    chat,
    health,
    incidents,
    places,
    push,
    sos,
    tools,
    users,
    weather,
)
from app.core.rate_limit import default_rate_limit

api_router = APIRouter(prefix="/api")

api_router.include_router(health.router)
api_router.include_router(users.router)
for _module in (chat, tools, places, weather, alerts, sos, incidents, push):
    api_router.include_router(_module.router, dependencies=[Depends(default_rate_limit)])

__all__ = ["api_router"]

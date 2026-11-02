"""Service layer: upstream data providers, notifications, persistence logic and the LLM.

Long-lived service objects are constructed once in the app lifespan (``app.main``) and stored
on ``app.state``; route handlers obtain them through the getters in ``app.api.deps``.
"""

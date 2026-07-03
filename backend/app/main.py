from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os
import time
import logging
from uuid import uuid4

# Rate limiting
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

# Load environment variables first, before importing any agents
load_dotenv()

from app.api import router as api_router

# Setup Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - [%(name)s] - %(message)s")
logger = logging.getLogger("ResQAI")

app = FastAPI(title="ResQ AI Backend", version="1.0.0")

# Setup Rate Limiter (e.g. 60 requests per minute per IP)
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# Allow all origins for the MVP
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_process_time_and_request_id(request: Request, call_next):
    start_time = time.time()
    request_id = str(uuid4())
    logger.info(f"Request ID {request_id} started: {request.method} {request.url.path}")
    
    response = await call_next(request)
    
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    response.headers["X-Request-ID"] = request_id
    logger.info(f"Request ID {request_id} completed: {response.status_code} in {process_time:.3f}s")
    
    return response

app.include_router(api_router, prefix="/api")

@app.get("/")
@limiter.exempt
async def root():
    return {"message": "Welcome to ResQ AI API"}

@app.get("/api/health")
@limiter.exempt
async def health_check():
    return {"status": "ok", "version": "1.0.0"}

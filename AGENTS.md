# AGENTS.md - Solar Archive Webapp Developer Guide

This document provides guidelines for agentic coding agents working in this repository.

## Project Overview

This repository contains two main projects:
1. **sunback** (`/Users/gilly/vscode/sunback/`) - Python package for solar image processing
2. **webapp** (`/Users/gilly/vscode/sunback/webapp/`) - FastAPI backend for the Solar Archive web service

The webapp is a FastAPI application that fetches solar images from NASA/SDO, applies processing filters (RHEF), and serves them via a web API.

---

## Build, Lint, and Test Commands

### Sunback Package (Main)

```bash
# Install in development mode
cd /Users/gilly/vscode/sunback
pip install -e .

# Install with test dependencies
pip install -e ".[test]"

# Run all tests
pytest -v sunback/__tests__/

# Run a single test file
pytest -v sunback/__tests__/test_sunback.py

# Run a single test
pytest -v sunback/__tests__/test_sunback.py::test_sunback_imported
pytest -v sunback/__tests__/test_parameters.py::TestParameters::test_check_real_number

# Run with coverage
pytest -v --cov=sunback sunback/__tests__/
```

### Webapp

```bash
# Install dependencies
cd /Users/gilly/vscode/sunback/webapp
pip install -r requirements.txt

# Run the development server
uvicorn api.main:app --reload --host 0.0.0.0 --port 8000

# Run with custom settings
SOLAR_ARCHIVE_DEBUG=1 uvicorn api.main:app --reload

# Clear caches
curl -X POST http://localhost:8000/api/clear_cache
```

---

## Code Style Guidelines

### Formatting

- **Line length**: Maximum 119 characters (enforced by flake8/YAPF)
- **Indentation**: 4 spaces (no tabs)
- **YAPF** is configured in `setup.cfg`:
  ```ini
  [yapf]
  COLUMN_LIMIT = 119
  INDENT_WIDTH = 4
  USE_TABS = False
  ```

### Naming Conventions

- **Classes**: PascalCase (e.g., `TestSunback`, `PreviewRequest`)
- **Functions/methods**: snake_case (e.g., `download_image`, `do_generate_sync`)
- **Constants**: SCREAMING_SNAKE_CASE (e.g., `DEFAULT_AIA_WAVELENGTH`, `OUTPUT_DIR`)
- **Variables**: lowercase with underscores where needed (e.g., `fits_path`, `url_path`)

### Type Hints

Use type hints for all function signatures:

```python
def _is_nasa_url(url: str) -> bool:
    ...

def get_downloader(total_timeout: int = 600, connect_timeout: int = 60) -> Downloader:
    ...

async def generate_preview(req: PreviewRequest = Body(...)) -> dict:
    ...
```

### Import Organization

Organize imports in the following order with blank lines between groups:

1. Standard library
2. Third-party packages
3. Local application imports

```python
# Standard library
import os
import ssl
import asyncio
from datetime import datetime, timedelta
from typing import Optional, Literal, Dict, Any
from pathlib import Path

# Third-party
import numpy as np
import requests
from fastapi import FastAPI, HTTPException, Query
from sunpy.map import Map

# Local application
from api import printify_routes
from sunback.processor import ImageProcessor
```

### Error Handling

- Use specific exception types rather than catching `Exception`
- For API endpoints, raise `HTTPException` with appropriate status codes
- Log errors with context before raising:

```python
try:
    smap = Map(fits_path)
except Exception as e:
    log_to_queue(f"[generate_preview] Failed to load FITS: {e}")
    raise HTTPException(status_code=502, detail=f"FITS processing failed: {e}")
```

### Logging

Use the `log_to_queue()` helper for all logging in async contexts:

```python
def log_to_queue(msg: str):
    """Add message to both the console and the live streaming log."""
    try:
        log_queue.put_nowait(msg)
    except Exception:
        pass
    print(msg, flush=True)
```

### Pydantic Models

Define request/response models using Pydantic:

```python
class PreviewRequest(BaseModel):
    date: str
    wavelength: int
    mission: str | None = "SDO"
    annotate: bool | None = False
```

### Async/Await

- Use `asyncio.to_thread()` for running synchronous code in async endpoints
- Use proper timeout handling for long-running operations

### Configuration

- Environment variables for configuration (use `.env` file for local dev)
- Use `os.getenv()` with sensible defaults
- Environment-specific URLs are set at startup in `api/main.py`

---

## Project Structure

```
sunback/
├── sunback/           # Main package
│   ├── __tests__/    # Unit tests
│   ├── processor/    # Image processing modules
│   ├── fetcher/      # Data fetching
│   ├── putter/       # Output handling
│   ├── movie/        # Video generation
│   ├── science/      # Scientific utilities
│   └── run/          # Execution scripts
└── webapp/           # FastAPI web service
    ├── api/
    │   ├── main.py           # Main API endpoints
    │   └── printify_routes.py  # Printify integration
    ├── dep/                 # Deprecated modules
    └── pipeline.py         # Data pipeline
```

---

## Testing Guidelines

1. Place tests in `sunback/__tests__/` directory
2. Use `unittest.TestCase` or pytest-style functions
3. Name test files as `test_*.py`
4. Name test functions as `test_*`
5. Use descriptive docstrings for test purposes

---

## API Development Notes

- SSL certificates for NASA are handled specially (see `ensure_nasa_cert()`)
- The API uses SSE (Server-Sent Events) for log streaming at `/logs/stream`
- Preview generation runs asynchronously with status polling at `/api/status/{task_id}`
- CORS is configured to allow all origins (`allow_origins=["*"]`)

---

## Dependencies

### Core (sunback)
- sunpy, astropy, scipy, matplotlib, opencv-python, boto3, xarray, requests

### Webapp
- fastapi, uvicorn, pydantic, sunpy[all], matplotlib, astropy, parfive, sunkit-image, aiapy, python-multipart, psutil, sse_starlette

---

## Common Tasks

### Running a specific API endpoint test
```bash
curl -X GET "http://localhost:8000/api/health"
```

### Clearing the cache
```bash
curl -X POST "http://localhost:8000/api/clear_preview_failed"
```

### Checking VSO connectivity
```bash
curl -X GET "http://localhost:8000/debug/vso"
```

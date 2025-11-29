#!/usr/bin/env python3
"""
5.1 Audio Router - Web Interface
FastAPI backend with LiteGraph.js frontend
"""

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import asyncio

from audio_router import AudioRouter

app = FastAPI()

# Mount static files
app.mount("/static", StaticFiles(directory="public"), name="static")

# Global audio router instance
router = None


async def broadcast_levels():
    """Broadcast audio levels to all connected websockets"""
    global router
    while router and router.running:
        data = {
            'type': 'levels',
            'input_levels': router.input_levels,
            'output_levels': router.output_levels
        }
        
        # Send to all connected clients
        for ws in router.websocket_clients[:]:
            try:
                await ws.send_json(data)
            except:
                router.websocket_clients.remove(ws)
        
        await asyncio.sleep(0.05)  # 20 FPS


# API endpoints
@app.get("/")
async def get_index():
    """Serve the main HTML page"""
    with open("public/index.html", "r") as f:
        return HTMLResponse(content=f.read())


@app.get("/style.css")
async def get_css():
    """Serve CSS file"""
    return FileResponse("public/style.css", media_type="text/css")


@app.get("/main.js")
async def get_js():
    """Serve JavaScript file"""
    return FileResponse("public/main.js", media_type="application/javascript")


@app.get("/api/devices")
async def get_devices():
    """Get available audio devices"""
    global router
    if router is None:
        router = AudioRouter()
    return router.get_devices()


@app.post("/api/start")
async def start_router(data: dict):
    """Start the audio router"""
    global router
    if router is None:
        router = AudioRouter()
    
    router.start(data['input_device_id'])
    
    # Start level broadcasting
    asyncio.create_task(broadcast_levels())
    
    return {"status": "started"}


@app.post("/api/stop")
async def stop_router():
    """Stop the audio router"""
    global router
    if router:
        router.stop()
    return {"status": "stopped"}


@app.post("/api/output/add")
async def add_output(data: dict):
    """Add an output device"""
    global router
    if router:
        router.add_output(data['device_id'])
    return {"status": "added"}


@app.post("/api/output/remove")
async def remove_output(data: dict):
    """Remove an output device"""
    global router
    if router:
        router.remove_output(data['device_id'])
    return {"status": "removed"}


@app.post("/api/connection/set_lr")
async def set_connection_lr(data: dict):
    """Set a connection between input channel and output device L or R"""
    global router
    if router:
        router.set_connection_lr(
            data['device_id'],
            data['channel_idx'],
            data['side'],
            data['mix_level']
        )
    return {"status": "set"}


@app.post("/api/connection/clear")
async def clear_connections(data: dict):
    """Clear all connections for a device"""
    global router
    if router:
        router.clear_connections(data['device_id'])
    return {"status": "cleared"}


@app.post("/api/latency/set")
async def set_latency(data: dict):
    """Set latency offset for an output device"""
    global router
    if router:
        router.set_latency(data['device_id'], data['latency_ms'])
    return {"status": "set"}


@app.get("/api/state")
async def get_state():
    """Get current router state"""
    global router
    if router:
        return router.get_state()
    return {}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket for real-time audio level updates"""
    await websocket.accept()
    global router
    if router:
        router.websocket_clients.append(websocket)
    
    try:
        while True:
            # Keep connection alive
            await websocket.receive_text()
    except:
        if router and websocket in router.websocket_clients:
            router.websocket_clients.remove(websocket)


if __name__ == "__main__":
    import uvicorn
    print("🎵 Starting 5.1 Audio Router Web Interface")
    print("📡 Open http://localhost:8000 in your browser")
    uvicorn.run(app, host="0.0.0.0", port=8000)

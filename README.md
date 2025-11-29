# 5.1 Audio Router

A web-based audio routing application that allows you to route 5.1 surround sound input to multiple stereo output devices with visual node-based mixing to create an Ad-hoc home theatre with devices of your choice.
<img width="2138" height="970" alt="image" src="https://github.com/user-attachments/assets/f519f4b3-c378-4b7e-956c-883dd232d995" />

## Features

- **Visual Node-Based Interface**: Drag-and-drop audio routing using LiteGraph.js
- **5.1 Surround Input**: Support for 6-channel audio input (FL, FR, C, LFE, SL, SR)
- **Multiple Outputs**: Route to multiple stereo output devices simultaneously
- **Flexible Mixing**: Mix any input channels to left or right output channels
- **Mixer Nodes**: Create intermediate mixer nodes for complex routing
- **Real-time Level Meters**: Visual feedback for all input and output channels
- **Latency Compensation**: Adjust latency per output device (0-1000ms)
- **WebSocket Updates**: Real-time audio level monitoring at 20 FPS

## Requirements

### Software
- Python 3.7+
- PyAudio
- FastAPI
- Uvicorn
- NumPy

### Virtual Audio Driver (Required)
A loopback virtual audio driver is required for this system to work:

- **macOS**: [BlackHole](https://github.com/ExistentialAudio/BlackHole) (free, open-source)
- **Windows**: [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) or [VoiceMeeter](https://vb-audio.com/Voicemeeter/) (free)
- **Linux**: PulseAudio or JACK with virtual devices

These drivers create virtual audio devices that allow you to route audio between applications and this router.

## Installation

1. Clone the repository:
```bash
git clone https://github.com/ChiragKalra/5.1-audio-router.git
cd 5.1-audio-router
```

2. Install dependencies:
```bash
pip install pyaudio fastapi uvicorn numpy
```

## Usage

1. Start the server:
```bash
python main.py
```

2. Open your browser to `http://localhost:8000`

3. Select your 5.1 input device and click "Start"

4. Add output devices from the sidebar

5. Connect input channels to output devices:
   - Drag from input source outputs (FL, FR, C, LFE, SL, SR)
   - Connect to output device inputs (L, R)
   - Multiple connections are supported for mixing

6. Use mixer nodes for intermediate mixing:
   - Click "+ Add Mixer" to create a mixer node
   - Adjust the number of inputs (2-8)
   - Connect multiple sources to the mixer
   - Connect mixer output to device inputs

## Controls

- **Pan/Zoom Canvas**: 
  - Middle mouse button to drag
  - Shift + Left click to drag
  - Mouse wheel to zoom
  
- **Latency Adjustment**: Use the slider on each output device node

## Architecture

- `main.py`: FastAPI web server and REST API endpoints
- `audio_router.py`: Core audio processing with PyAudio
- `public/`: Frontend files (HTML, CSS, JavaScript)
  - `index.html`: Main page structure
  - `main.js`: LiteGraph.js integration and UI logic
  - `style.css`: Styling

## API Endpoints

- `GET /api/devices`: List available audio devices
- `POST /api/start`: Start audio routing
- `POST /api/stop`: Stop audio routing
- `POST /api/output/add`: Add output device
- `POST /api/output/remove`: Remove output device
- `POST /api/connection/set_lr`: Set channel connection
- `POST /api/connection/clear`: Clear device connections
- `POST /api/latency/set`: Set latency compensation
- `GET /api/state`: Get current router state
- `WebSocket /ws`: Real-time audio level updates

## License

MIT

## Author

Chirag Kalra

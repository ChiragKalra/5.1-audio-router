#!/usr/bin/env python3
"""
Audio Router - Core audio processing logic
Handles PyAudio streams, mixing, and routing
"""

import pyaudio
import numpy as np
import threading
from collections import deque
from typing import Dict, List

# Audio config
SAMPLE_RATE = 48000
CHUNK_SIZE = 512


class AudioRouter:
    def __init__(self):
        self.p = pyaudio.PyAudio()
        self.running = False
        self.input_device = None
        self.output_devices = {}
        self.connections = {}  # {output_device: {'L': {channel_idx: mix_level}, 'R': {channel_idx: mix_level}}}
        self.latency_offsets = {}  # {output_device: samples}
        self.latency_buffers = {}  # {output_device: deque}
        self.input_levels = [0.0] * 6
        self.output_levels = {}
        self.streams = {}
        self.websocket_clients = []
        
    def get_devices(self):
        """Get all available audio devices"""
        devices = {'input': [], 'output': []}
        for i in range(self.p.get_device_count()):
            info = self.p.get_device_info_by_index(i)
            if info['maxInputChannels'] >= 6:
                devices['input'].append({
                    'id': i, 
                    'name': info['name'],
                    'channels': info['maxInputChannels']
                })
            if info['maxOutputChannels'] >= 2:
                devices['output'].append({
                    'id': i, 
                    'name': info['name'],
                    'channels': info['maxOutputChannels']
                })
        return devices
    
    def start(self, input_device_id):
        """Start audio routing"""
        if self.running:
            return
        
        self.input_device = input_device_id
        self.running = True
        
        # Open input stream
        self.input_stream = self.p.open(
            format=pyaudio.paFloat32,
            channels=6,
            rate=SAMPLE_RATE,
            input=True,
            input_device_index=input_device_id,
            frames_per_buffer=CHUNK_SIZE
        )
        
        # Start processing thread
        self.thread = threading.Thread(target=self._process_audio, daemon=True)
        self.thread.start()
    
    def stop(self):
        """Stop audio routing"""
        self.running = False
        if hasattr(self, 'input_stream'):
            self.input_stream.stop_stream()
            self.input_stream.close()
        for stream in self.streams.values():
            stream.stop_stream()
            stream.close()
        self.streams.clear()
    
    def add_output(self, device_id):
        """Add an output device"""
        if device_id not in self.output_devices:
            device_info = self.p.get_device_info_by_index(device_id)
            self.output_devices[device_id] = device_info['name']
            self.connections[device_id] = {'L': {}, 'R': {}}
            self.latency_offsets[device_id] = 0
            self.latency_buffers[device_id] = deque(maxlen=SAMPLE_RATE * 2)
            self.output_levels[device_id] = [0.0, 0.0]
            
            # Open output stream
            if self.running:
                self.streams[device_id] = self.p.open(
                    format=pyaudio.paFloat32,
                    channels=2,
                    rate=SAMPLE_RATE,
                    output=True,
                    output_device_index=device_id,
                    frames_per_buffer=CHUNK_SIZE
                )
    
    def remove_output(self, device_id):
        """Remove an output device"""
        if device_id in self.output_devices:
            if device_id in self.streams:
                self.streams[device_id].stop_stream()
                self.streams[device_id].close()
                del self.streams[device_id]
            del self.output_devices[device_id]
            del self.connections[device_id]
            del self.latency_offsets[device_id]
            del self.latency_buffers[device_id]
            del self.output_levels[device_id]
    
    def set_connection_lr(self, device_id, channel_idx, side, mix_level):
        """Set connection between input channel and output device L or R"""
        if device_id in self.connections and side in ['L', 'R']:
            if mix_level > 0:
                self.connections[device_id][side][channel_idx] = mix_level
            elif channel_idx in self.connections[device_id][side]:
                del self.connections[device_id][side][channel_idx]
    
    def clear_connections(self, device_id):
        """Clear all connections for a device"""
        if device_id in self.connections:
            self.connections[device_id] = {'L': {}, 'R': {}}
    
    def set_latency(self, device_id, ms):
        """Set latency offset in milliseconds"""
        if device_id in self.latency_offsets:
            self.latency_offsets[device_id] = int((ms / 1000.0) * SAMPLE_RATE)
    
    def get_state(self):
        """Get current router state"""
        return {
            'running': self.running,
            'input_device': self.input_device,
            'output_devices': self.output_devices,
            'connections': self.connections,
            'latency_offsets': {k: v / SAMPLE_RATE * 1000 for k, v in self.latency_offsets.items()},
            'input_levels': self.input_levels,
            'output_levels': self.output_levels
        }
    
    def _process_audio(self):
        """Main audio processing loop"""
        while self.running:
            try:
                # Read input
                data = self.input_stream.read(CHUNK_SIZE, exception_on_overflow=False)
                audio = np.frombuffer(data, dtype=np.float32)
                audio = audio.reshape(-1, 6)
                
                # Update input levels
                for i in range(6):
                    self.input_levels[i] = float(np.max(np.abs(audio[:, i])))
                
                # Process each output device
                for device_id in list(self.output_devices.keys()):
                    if device_id not in self.streams:
                        continue
                    
                    # Mix connected channels for L and R separately
                    l_mix = self.connections[device_id]['L']
                    r_mix = self.connections[device_id]['R']
                    
                    # Mix L channel
                    left = np.zeros(CHUNK_SIZE, dtype=np.float32)
                    for ch_idx, mix_level in l_mix.items():
                        left += audio[:, ch_idx] * mix_level
                    
                    # Mix R channel
                    right = np.zeros(CHUNK_SIZE, dtype=np.float32)
                    for ch_idx, mix_level in r_mix.items():
                        right += audio[:, ch_idx] * mix_level
                    
                    output = np.column_stack([left, right]).astype(np.float32)
                    
                    # Apply latency compensation
                    latency = self.latency_offsets[device_id]
                    buffer = self.latency_buffers[device_id]
                    
                    if latency > 0:
                        # Add to buffer
                        buffer.extend(output.flatten())
                        
                        # Output from buffer if enough samples
                        if len(buffer) >= CHUNK_SIZE * 2 + latency:
                            delayed = np.array(list(buffer)[:CHUNK_SIZE * 2])
                            output = delayed.reshape(-1, 2).astype(np.float32)
                            # Remove consumed samples
                            for _ in range(CHUNK_SIZE * 2):
                                buffer.popleft()
                        else:
                            output = np.zeros((CHUNK_SIZE, 2), dtype=np.float32)
                    
                    # Update output levels
                    self.output_levels[device_id] = [
                        float(np.max(np.abs(output[:, 0]))),
                        float(np.max(np.abs(output[:, 1])))
                    ]
                    
                    # Write output
                    try:
                        self.streams[device_id].write(output.tobytes())
                    except:
                        pass
                        
            except Exception as e:
                print(f"Audio error: {e}")
                continue

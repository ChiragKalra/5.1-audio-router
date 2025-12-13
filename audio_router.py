#!/usr/bin/env python3
"""
Audio Router - Core audio processing logic
Handles PyAudio streams, mixing, and routing
"""

import pyaudio
import numpy as np
import threading
import math
from collections import deque
from typing import Dict, List

# Audio config
# SAMPLE_RATE = 48000  # Now dynamic
CHUNK_SIZE = 512


class BiquadFilter:
    """Fast biquad filter implementation for real-time audio processing"""
    
    def __init__(self):
        self.b0 = 1.0
        self.b1 = 0.0
        self.b2 = 0.0
        self.a1 = 0.0
        self.a2 = 0.0
        # State variables for Direct Form II
        self.z1 = 0.0
        self.z2 = 0.0
    
    def set_highpass(self, cutoff_freq, sample_rate, q=0.707):
        """Configure as high-pass filter"""
        w0 = 2.0 * math.pi * cutoff_freq / sample_rate
        cos_w0 = math.cos(w0)
        sin_w0 = math.sin(w0)
        alpha = sin_w0 / (2.0 * q)
        
        b0 = (1.0 + cos_w0) / 2.0
        b1 = -(1.0 + cos_w0)
        b2 = (1.0 + cos_w0) / 2.0
        a0 = 1.0 + alpha
        a1 = -2.0 * cos_w0
        a2 = 1.0 - alpha
        
        # Normalize
        self.b0 = b0 / a0
        self.b1 = b1 / a0
        self.b2 = b2 / a0
        self.a1 = a1 / a0
        self.a2 = a2 / a0
    
    def set_lowpass(self, cutoff_freq, sample_rate, q=0.707):
        """Configure as low-pass filter"""
        w0 = 2.0 * math.pi * cutoff_freq / sample_rate
        cos_w0 = math.cos(w0)
        sin_w0 = math.sin(w0)
        alpha = sin_w0 / (2.0 * q)
        
        b0 = (1.0 - cos_w0) / 2.0
        b1 = 1.0 - cos_w0
        b2 = (1.0 - cos_w0) / 2.0
        a0 = 1.0 + alpha
        a1 = -2.0 * cos_w0
        a2 = 1.0 - alpha
        
        # Normalize
        self.b0 = b0 / a0
        self.b1 = b1 / a0
        self.b2 = b2 / a0
        self.a1 = a1 / a0
        self.a2 = a2 / a0
    
    def reset(self):
        """Reset filter state"""
        self.z1 = 0.0
        self.z2 = 0.0
    
    def process(self, samples):
        """Process audio samples using Direct Form II (VECTORIZED for speed!)"""
        n = len(samples)
        output = np.empty(n, dtype=np.float32)
        
        # Use local variables for speed
        b0, b1, b2 = self.b0, self.b1, self.b2
        a1, a2 = self.a1, self.a2
        z1, z2 = self.z1, self.z2
        
        # Process samples (still a loop but with minimal overhead)
        for i in range(n):
            x = samples[i]
            y = b0 * x + z1
            z1 = b1 * x - a1 * y + z2
            z2 = b2 * x - a2 * y
            output[i] = y
        
        # Update state
        self.z1 = z1
        self.z2 = z2
        
        return output


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
        self.sample_rate = 48000  # Default, will be updated on start
        self.websocket_clients = []
        
        # Frequency filter settings per output device
        self.filters = {}  # {output_device: {'low_cutoff': Hz, 'high_cutoff': Hz, 'sos_L': filter_state, 'sos_R': filter_state, 'zi_L': initial_conditions, 'zi_R': initial_conditions}}
        
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
        
        # Get device info to set sample rate
        try:
            dev_info = self.p.get_device_info_by_index(input_device_id)
            self.sample_rate = int(dev_info['defaultSampleRate'])
        except:
            self.sample_rate = 48000
            
        # Re-initialize buffers with correct sample rate
        for dev_id in self.output_devices:
            self.latency_buffers[dev_id] = deque(maxlen=self.sample_rate * 2)
            
            # Open output streams if they don't exist
            if dev_id not in self.streams:
                try:
                    self.streams[dev_id] = self.p.open(
                        format=pyaudio.paFloat32,
                        channels=2,
                        rate=self.sample_rate,
                        output=True,
                        output_device_index=dev_id,
                        frames_per_buffer=CHUNK_SIZE
                    )
                except Exception as e:
                    print(f"Failed to open output device {dev_id}: {e}")

        # Open input stream
        self.input_stream = self.p.open(
            format=pyaudio.paFloat32,
            channels=6,
            rate=self.sample_rate,
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
            self.latency_buffer_len = int(self.sample_rate * 0.5) # Default buffer size (0.5s)?? No, logic was maxlen=SAMPLE_RATE*2
            self.latency_buffers[device_id] = deque(maxlen=self.sample_rate * 2)
            self.output_levels[device_id] = [0.0, 0.0]
            
            # Initialize filter settings (cascaded biquad filters for each channel)
            self.filters[device_id] = {
                'low_cutoff': 20,
                'high_cutoff': 25000,
                'highpass_L': BiquadFilter(),
                'lowpass_L': BiquadFilter(),
                'highpass_R': BiquadFilter(),
                'lowpass_R': BiquadFilter(),
                'enabled': False
            }
            
            # Open output stream
            if self.running:
                try:
                    self.streams[device_id] = self.p.open(
                        format=pyaudio.paFloat32,
                        channels=2,
                        rate=self.sample_rate,
                        output=True,
                        output_device_index=device_id,
                        frames_per_buffer=CHUNK_SIZE
                    )
                except Exception as e:
                    print(f"Error opening output stream for device {device_id}: {e}")
    
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
            if device_id in self.filters:
                del self.filters[device_id]
    
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
            self.latency_offsets[device_id] = int((ms / 1000.0) * self.sample_rate)
    
    def set_filter(self, device_id, low_cutoff, high_cutoff):
        """Set frequency cutoff filter for an output device using fast biquad filters"""
        if device_id not in self.filters:
            return
        
        filter_cfg = self.filters[device_id]
        
        # Update cutoff frequencies
        filter_cfg['low_cutoff'] = low_cutoff
        filter_cfg['high_cutoff'] = high_cutoff
        
        # Ensure cutoffs are within valid range
        nyquist = self.sample_rate / 2.0
        low_cutoff = max(20, min(low_cutoff, nyquist - 100))
        high_cutoff = max(low_cutoff + 100, min(high_cutoff, nyquist - 10))
        
        # Configure biquad filters for left channel
        filter_cfg['highpass_L'].set_highpass(low_cutoff, self.sample_rate)
        filter_cfg['lowpass_L'].set_lowpass(high_cutoff, self.sample_rate)
        filter_cfg['highpass_L'].reset()
        filter_cfg['lowpass_L'].reset()
        
        # Configure biquad filters for right channel
        filter_cfg['highpass_R'].set_highpass(low_cutoff, self.sample_rate)
        filter_cfg['lowpass_R'].set_lowpass(high_cutoff, self.sample_rate)
        filter_cfg['highpass_R'].reset()
        filter_cfg['lowpass_R'].reset()
        
        # Enable filtering
        filter_cfg['enabled'] = True
    
    def get_state(self):
        """Get current router state"""
        return {
            'running': self.running,
            'input_device': self.input_device,
            'output_devices': self.output_devices,
            'connections': self.connections,
            'latency_offsets': {k: v / self.sample_rate * 1000 for k, v in self.latency_offsets.items()},
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
                    
                    # Apply frequency cutoff filter if enabled (FAST biquad filters!)
                    if device_id in self.filters and self.filters[device_id]['enabled']:
                        filter_cfg = self.filters[device_id]
                        
                        # Apply cascaded filters to left channel (highpass -> lowpass)
                        left = filter_cfg['highpass_L'].process(left)
                        left = filter_cfg['lowpass_L'].process(left)
                        
                        # Apply cascaded filters to right channel (highpass -> lowpass)
                        right = filter_cfg['highpass_R'].process(right)
                        right = filter_cfg['lowpass_R'].process(right)
                    
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

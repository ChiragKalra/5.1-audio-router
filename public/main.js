const graph = new LGraph();
const canvas = new LGraphCanvas("#mycanvas", graph);

// Fix zoom and scale
canvas.ds.scale = 1.0;
canvas.ds.offset = [0, 0];
canvas.allow_dragcanvas = true;
canvas.allow_dragnodes = true;
canvas.background_image = null;
canvas.render_canvas_border = false;
canvas.render_connections_shadows = false;
canvas.render_connections_border = true;
canvas.highquality_render = true;
canvas.use_gradients = true;

// Slow down zoom speed and set better limits
canvas.ds.min_scale = 0.5;
canvas.ds.max_scale = 1.5;

// Always allow canvas dragging regardless of nodes
canvas.allow_dragcanvas = true;
canvas.dragging_canvas = false;

// Override zoom behavior for smoother control
const originalProcessMouseWheel = canvas.processMouseWheel.bind(canvas);
canvas.processMouseWheel = function (e) {
    const delta = e.wheelDeltaY != null ? e.wheelDeltaY : e.detail * -60;
    const scale = this.ds.scale;

    // Reduce zoom speed by 70%
    if (delta > 0) {
        this.ds.scale *= 1.03; // was ~1.1
    } else if (delta < 0) {
        this.ds.scale *= 0.97; // was ~0.9
    }

    // Clamp scale
    this.ds.scale = Math.max(this.ds.min_scale, Math.min(this.ds.max_scale, this.ds.scale));

    this.dirty_canvas = true;
    this.dirty_bgcanvas = true;

    e.preventDefault();
    return false;
};

// Ensure canvas can always be dragged with middle mouse or space+drag
const canvasEl = document.getElementById('mycanvas');
let isDraggingCanvas = false;
let lastMousePos = null;

canvasEl.addEventListener('mousedown', function (e) {
    // Middle mouse button or shift+left click for canvas drag
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        isDraggingCanvas = true;
        lastMousePos = [e.clientX, e.clientY];
        e.preventDefault();
    }
});

canvasEl.addEventListener('mousemove', function (e) {
    if (isDraggingCanvas && lastMousePos) {
        const dx = e.clientX - lastMousePos[0];
        const dy = e.clientY - lastMousePos[1];

        canvas.ds.offset[0] += dx;
        canvas.ds.offset[1] += dy;

        lastMousePos = [e.clientX, e.clientY];
        canvas.dirty_canvas = true;
        canvas.dirty_bgcanvas = true;
        e.preventDefault();
    }
});

canvasEl.addEventListener('mouseup', function (e) {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        isDraggingCanvas = false;
        lastMousePos = null;
    }
});

canvasEl.addEventListener('mouseleave', function () {
    isDraggingCanvas = false;
    lastMousePos = null;
});

let devices = { input: [], output: [] };
let inputNode = null;
let outputNodes = {};
let ws = null;

// Custom Input Node
function InputSourceNode() {
    this.addOutput("FL", "audio");
    this.addOutput("FR", "audio");
    this.addOutput("C", "audio");
    this.addOutput("LFE", "audio");
    this.addOutput("SL", "audio");
    this.addOutput("SR", "audio");

    this.levels = [0, 0, 0, 0, 0, 0];
    this.size = [220, 220];
}

InputSourceNode.title = "Input Source";
InputSourceNode.prototype.onDrawForeground = function (ctx) {
    if (!this.levels) return;

    const labels = ["FL", "FR", "C", "LFE", "SL", "SR"];
    const startY = 40;
    const spacing = 30;

    for (let i = 0; i < 6; i++) {
        const y = startY + i * spacing;
        const level = this.levels[i];
        const meterWidth = level * 140;

        // Draw label first (left side)
        ctx.fillStyle = "#fff";
        ctx.font = "12px Arial";
        ctx.textAlign = "left";
        ctx.fillText(labels[i], 10, y + 6);

        // Draw level meter
        ctx.fillStyle = "#2d5";
        ctx.fillRect(45, y, meterWidth, 10);

        // Draw meter background
        ctx.strokeStyle = "#444";
        ctx.strokeRect(45, y, 140, 10);
    }
};

LiteGraph.registerNodeType("audio/input", InputSourceNode);

// Custom Mixer Node - accepts multiple inputs, outputs one mixed signal
function MixerNode() {
    this.addInput("In 1", "audio");
    this.addInput("In 2", "audio");
    this.addOutput("Mix", "audio");

    this.properties = {
        num_inputs: 2
    };

    this.size = [180, 100];

    this.addWidget("number", "Inputs", 2, (v) => {
        const newCount = Math.max(2, Math.min(8, Math.round(v)));
        if (newCount !== this.properties.num_inputs) {
            this.properties.num_inputs = newCount;
            this.updateInputs();
        }
        return newCount;
    }, { min: 2, max: 8, step: 1, precision: 0 });
}

MixerNode.title = "Mixer";

MixerNode.prototype.updateInputs = function () {
    const currentCount = this.inputs.length;
    const targetCount = this.properties.num_inputs;

    if (targetCount > currentCount) {
        // Add inputs
        for (let i = currentCount; i < targetCount; i++) {
            this.addInput(`In ${i + 1}`, "audio");
        }
    } else if (targetCount < currentCount) {
        // Remove inputs
        for (let i = currentCount - 1; i >= targetCount; i--) {
            this.removeInput(i);
        }
    }

    this.size[1] = 60 + this.inputs.length * 20;
};

MixerNode.prototype.onDrawForeground = function (ctx) {
    // Show input count
    ctx.fillStyle = "#888";
    ctx.font = "10px Arial";
    ctx.textAlign = "center";
    ctx.fillText(`${this.inputs.length} → 1`, this.size[0] / 2, this.size[1] - 10);
};

LiteGraph.registerNodeType("audio/mixer", MixerNode);

// Custom Frequency Cutoff Node - filters audio with high-pass and low-pass
function FreqCutoffNode() {
    this.addInput("In", "audio");
    this.addOutput("Out", "audio");

    this.properties = {
        low_cutoff: 20,    // Hz - frequencies below this are cut
        high_cutoff: 25000 // Hz - frequencies above this are cut
    };

    this.size = [200, 120];

    // Low cutoff slider (high-pass filter)
    this.addWidget("number", "Low Cut (Hz)", 20, (v) => {
        this.properties.low_cutoff = Math.max(20, Math.min(this.properties.high_cutoff - 10, v));
        return this.properties.low_cutoff;
    }, { min: 20, max: 25000, step: 10, precision: 0 });

    // High cutoff slider (low-pass filter)
    this.addWidget("number", "High Cut (Hz)", 25000, (v) => {
        this.properties.high_cutoff = Math.max(this.properties.low_cutoff + 10, Math.min(25000, v));
        return this.properties.high_cutoff;
    }, { min: 20, max: 25000, step: 10, precision: 0 });
}

FreqCutoffNode.title = "Freq Cutoff";

FreqCutoffNode.prototype.onDrawForeground = function (ctx) {
    // Show frequency range
    ctx.fillStyle = "#888";
    ctx.font = "10px Arial";
    ctx.textAlign = "center";

    const low = this.properties.low_cutoff;
    const high = this.properties.high_cutoff;

    // Format frequency values
    const formatFreq = (freq) => {
        if (freq >= 1000) {
            return (freq / 1000).toFixed(1) + "kHz";
        }
        return freq + "Hz";
    };

    ctx.fillText(`Pass: ${formatFreq(low)} - ${formatFreq(high)}`, this.size[0] / 2, this.size[1] - 10);
};

LiteGraph.registerNodeType("audio/filter", FreqCutoffNode);

// Custom Output Node
function OutputDeviceNode() {
    // Separate L and R inputs, each accepting multiple connections
    this.addInput("L", "audio");
    this.addInput("R", "audio");

    this.properties = {
        device_id: -1,
        device_name: "",
        latency: 0,
        low_cutoff: 20,
        high_cutoff: 25000
    };

    this.levels = [0, 0];
    this.size = [240, 250];

    this.addWidget("slider", "Latency (ms)", 0, (v) => {
        this.properties.latency = v;
        setLatency(this.properties.device_id, v);
    }, { min: 0, max: 1000, step: 25 });

    this.addWidget("number", "Low Cut (Hz)", 20, (v) => {
        this.properties.low_cutoff = Math.max(20, Math.min(this.properties.high_cutoff - 10, v));
        setFilter(this.properties.device_id, this.properties.low_cutoff, this.properties.high_cutoff);
        return this.properties.low_cutoff;
    }, { min: 20, max: 25000, step: 10, precision: 0 });

    this.addWidget("number", "High Cut (Hz)", 25000, (v) => {
        this.properties.high_cutoff = Math.max(this.properties.low_cutoff + 10, Math.min(25000, v));
        setFilter(this.properties.device_id, this.properties.low_cutoff, this.properties.high_cutoff);
        return this.properties.high_cutoff;
    }, { min: 20, max: 25000, step: 10, precision: 0 });
}

// Override onConnectInput to allow multiple connections
OutputDeviceNode.prototype.onConnectInput = function (target_slot, type, output, origin_node, origin_slot) {
    // Don't disconnect existing connections
    const input = this.inputs[target_slot];

    // Convert to array if needed
    if (input.link != null && !Array.isArray(input.link)) {
        input.link = [input.link];
    } else if (input.link == null) {
        input.link = [];
    }

    return -1; // Return -1 to prevent default disconnect behavior
};

OutputDeviceNode.title = "Output Device";

OutputDeviceNode.prototype.onRemoved = function () {
    // Clean up when node is removed
    if (this.properties.device_id >= 0) {
        // Remove from backend
        fetch('/api/output/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: this.properties.device_id })
        });

        // Remove from outputNodes tracking
        delete outputNodes[this.properties.device_id];

        // Update sidebar
        renderDeviceList();
    }
};

OutputDeviceNode.prototype.onDrawForeground = function (ctx) {
    if (!this.levels) return;

    // Push meters down below widgets (Latency + 2 filters take up ~120px)
    const startY = 150;
    const meterWidth = 150;
    const labelWidth = 40;

    // Draw output level meters
    ctx.fillStyle = "#ccc";
    ctx.font = "12px Arial";
    ctx.textAlign = "left";

    // L channel meter
    ctx.fillText("L Out", 10, startY + 8);

    // Draw L meter background
    ctx.fillStyle = "#222";
    ctx.fillRect(55, startY, meterWidth, 10);

    // Draw L meter level
    ctx.fillStyle = "#2d5";
    ctx.fillRect(55, startY, Math.min(1.0, this.levels[0]) * meterWidth, 10);

    // Draw L meter border
    ctx.strokeStyle = "#555";
    ctx.strokeRect(55, startY, meterWidth, 10);

    // R channel meter
    ctx.fillStyle = "#ccc";
    ctx.fillText("R Out", 10, startY + 28);

    // Draw R meter background
    ctx.fillStyle = "#222";
    ctx.fillRect(55, startY + 20, meterWidth, 10);

    // Draw R meter level
    ctx.fillStyle = "#2d5";
    ctx.fillRect(55, startY + 20, Math.min(1.0, this.levels[1]) * meterWidth, 10);

    // Draw R meter border
    ctx.strokeStyle = "#555";
    ctx.strokeRect(55, startY + 20, meterWidth, 10);

    // Show connection counts
    const lCount = Array.isArray(this.inputs[0].link) ? this.inputs[0].link.length : (this.inputs[0].link ? 1 : 0);
    const rCount = Array.isArray(this.inputs[1].link) ? this.inputs[1].link.length : (this.inputs[1].link ? 1 : 0);

    ctx.fillStyle = "#666";
    ctx.font = "10px Arial";
    ctx.textAlign = "center";
    ctx.fillText(`Inputs: ${lCount} L / ${rCount} R`, this.size[0] / 2, startY + 45);
};

OutputDeviceNode.prototype.onConnectionsChange = function (type, index, connected, link_info) {
    if (type === LiteGraph.INPUT && this.properties.device_id >= 0) {
        if (connected) {
            // Connection added - just add this one
            const side = index === 0 ? 'L' : 'R';
            const link = graph.links[link_info.id];
            if (link) {
                const channel_idx = link.origin_slot;
                setConnectionLR(this.properties.device_id, channel_idx, side, 1.0);
            }
        } else {
            // Connection removed - recalculate all to sync state
            this.updateAllConnections();
        }
    }
};

OutputDeviceNode.prototype.updateAllConnections = function () {
    if (this.properties.device_id < 0) return;

    // Clear all connections first (only when recalculating)
    clearAllConnections(this.properties.device_id);

    // Process L channel connections (input 0)
    if (this.inputs && this.inputs[0]) {
        const input = this.inputs[0];
        let links = [];

        if (input.link != null) {
            if (Array.isArray(input.link)) {
                links = input.link.filter(l => l != null);
            } else {
                links = [input.link];
            }
        }

        links.forEach(link_id => {
            const link = graph.links[link_id];
            if (link) {
                const channel_idx = link.origin_slot;
                setConnectionLR(this.properties.device_id, channel_idx, 'L', 1.0);
            }
        });
    }

    // Process R channel connections (input 1)
    if (this.inputs && this.inputs[1]) {
        const input = this.inputs[1];
        let links = [];

        if (input.link != null) {
            if (Array.isArray(input.link)) {
                links = input.link.filter(l => l != null);
            } else {
                links = [input.link];
            }
        }

        links.forEach(link_id => {
            const link = graph.links[link_id];
            if (link) {
                const channel_idx = link.origin_slot;
                setConnectionLR(this.properties.device_id, channel_idx, 'R', 1.0);
            }
        });
    }
};

LiteGraph.registerNodeType("audio/output", OutputDeviceNode);

// Configure LiteGraph to allow multiple connections
LiteGraph.allow_multi_output_for_events = true;

// Patch disconnect to handle array-based links
const originalDisconnect = LGraph.prototype.disconnect;
LGraph.prototype.disconnect = function (node1, slot1, node2, slot2) {
    if (node2 && node2.type === "audio/output") {
        const input = node2.inputs[slot2];

        if (!input || !input.link) {
            return false;
        }

        // Handle array of links
        if (Array.isArray(input.link)) {
            const linkIndex = input.link.findIndex(lid => {
                const link = this.links[lid];
                return link && link.origin_id === node1.id && link.origin_slot === slot1;
            });

            if (linkIndex === -1) {
                return false;
            }

            const link_id = input.link[linkIndex];
            const link = this.links[link_id];

            if (!link) {
                return false;
            }

            // Remove from output
            if (node1.outputs[slot1].links) {
                const outIndex = node1.outputs[slot1].links.indexOf(link_id);
                if (outIndex !== -1) {
                    node1.outputs[slot1].links.splice(outIndex, 1);
                }
            }

            // Remove from input array
            input.link.splice(linkIndex, 1);

            // Clean up empty array
            if (input.link.length === 0) {
                input.link = null;
            }

            // Delete link
            delete this.links[link_id];

            // Trigger callbacks
            if (node1.onConnectionsChange) {
                node1.onConnectionsChange(LiteGraph.OUTPUT, slot1, false, link, node1.outputs[slot1]);
            }
            if (node2.onConnectionsChange) {
                node2.onConnectionsChange(LiteGraph.INPUT, slot2, false, link, input);
            }

            this._version++;
            this.setDirtyCanvas(true, false);

            return true;
        }
    }

    // Default behavior
    return originalDisconnect.call(this, node1, slot1, node2, slot2);
};

// Patch LGraph.prototype.connect to support multiple input connections
const originalConnect = LGraph.prototype.connect;
LGraph.prototype.connect = function (node1, slot1, node2, slot2) {
    // Check if target node is OutputDeviceNode
    if (node2 && node2.type === "audio/output") {
        const input = node2.inputs[slot2];
        const output = node1.outputs[slot1];

        // Convert existing link to array if needed
        if (input.link != null && !Array.isArray(input.link)) {
            input.link = [input.link];
        } else if (input.link == null) {
            input.link = [];
        }

        // Check if this exact connection already exists
        const alreadyConnected = input.link.some(lid => {
            const l = this.links[lid];
            return l && l.origin_id === node1.id && l.origin_slot === slot1;
        });

        if (alreadyConnected) {
            return null; // Connection already exists
        }

        // Create the link manually
        const link_id = ++this.last_link_id;
        const link = {
            id: link_id,
            type: output.type || "audio",
            origin_id: node1.id,
            origin_slot: slot1,
            target_id: node2.id,
            target_slot: slot2
        };

        this.links[link_id] = link;

        // Add to output
        if (!output.links) {
            output.links = [];
        }
        output.links.push(link_id);

        // Add to input array
        input.link.push(link_id);

        // Trigger callbacks
        if (node1.onConnectionsChange) {
            node1.onConnectionsChange(LiteGraph.OUTPUT, slot1, true, link, output);
        }
        if (node2.onConnectionsChange) {
            node2.onConnectionsChange(LiteGraph.INPUT, slot2, true, link, input);
        }

        if (this.onNodeConnectionChange) {
            this.onNodeConnectionChange(LiteGraph.INPUT, node2, slot2, node1, slot1);
            this.onNodeConnectionChange(LiteGraph.OUTPUT, node1, slot1, node2, slot2);
        }

        this._version++;
        this.setDirtyCanvas(true, false);

        return link_id;
    }

    // Default behavior for other nodes
    return originalConnect.call(this, node1, slot1, node2, slot2);
};

// Load devices
async function loadDevices() {
    const response = await fetch('/api/devices');
    devices = await response.json();

    // Populate input device dropdown
    const select = document.getElementById('inputDevice');
    select.innerHTML = '<option value="">Select Input Device...</option>';
    devices.input.forEach(dev => {
        const option = document.createElement('option');
        option.value = dev.id;
        option.textContent = dev.name;
        select.appendChild(option);
    });

    // Populate output device sidebar
    renderDeviceList();
}

// Render device list in sidebar
function renderDeviceList() {
    const list = document.getElementById('device-list');
    list.innerHTML = '';

    devices.output.forEach(dev => {
        const isAdded = outputNodes.hasOwnProperty(dev.id);

        const block = document.createElement('div');
        block.className = 'device-block' + (isAdded ? ' added' : '');
        block.onclick = () => {
            if (!isAdded) {
                addOutputNodeById(dev.id);
            }
        };

        block.innerHTML = `
            <div class="device-name">${dev.name}</div>
            <div class="device-info">ID: ${dev.id} • ${dev.channels} channels</div>
            ${isAdded ? '<span class="device-badge" style="background: #666;">ADDED</span>' : '<span class="device-badge">CLICK TO ADD</span>'}
        `;

        list.appendChild(block);
    });
}

// Start router
async function startRouter() {
    const select = document.getElementById('inputDevice');
    const deviceId = parseInt(select.value);
    if (isNaN(deviceId)) {
        alert('Please select an input device');
        return;
    }

    await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input_device_id: deviceId })
    });

    // Create input node with device name
    if (!inputNode) {
        const deviceName = select.options[select.selectedIndex].text;
        inputNode = LiteGraph.createNode("audio/input");
        inputNode.title = deviceName;
        inputNode.pos = [50, 100];
        graph.add(inputNode);
    }

    // Connect WebSocket
    connectWebSocket();

    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('inputDevice').disabled = true;
    document.getElementById('status').textContent = 'RUNNING';
    document.getElementById('status').className = 'status running';
}

// Stop router
async function stopRouter() {
    await fetch('/api/stop', { method: 'POST' });

    if (ws) {
        ws.close();
        ws = null;
    }

    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('inputDevice').disabled = false;
    document.getElementById('status').textContent = 'STOPPED';
    document.getElementById('status').className = 'status stopped';
}

// Add mixer node
function addMixerNode() {
    const node = LiteGraph.createNode("audio/mixer");
    node.pos = [350, 100 + Math.random() * 200];
    graph.add(node);
}

// Add frequency cutoff filter node
function addFilterNode() {
    const node = LiteGraph.createNode("audio/filter");
    node.pos = [350, 100 + Math.random() * 200];
    graph.add(node);
}

// Add output node by ID
function addOutputNodeById(id) {
    if (outputNodes.hasOwnProperty(id)) {
        return; // Already added
    }

    const device = devices.output.find(d => d.id === id);
    if (!device) {
        alert('Invalid device ID');
        return;
    }

    fetch('/api/output/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: id })
    });

    const node = LiteGraph.createNode("audio/output");
    node.properties.device_id = id;
    node.properties.device_name = device.name;
    node.title = device.name;
    node.pos = [600, 100 + Object.keys(outputNodes).length * 150];
    graph.add(node);

    outputNodes[id] = node;

    // Update sidebar
    renderDeviceList();
}

// Set connection for L or R channel
async function setConnectionLR(deviceId, channelIdx, side, mixLevel) {
    await fetch('/api/connection/set_lr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_id: deviceId,
            channel_idx: channelIdx,
            side: side,
            mix_level: mixLevel
        })
    });
}

// Clear all connections for a device
async function clearAllConnections(deviceId) {
    await fetch('/api/connection/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_id: deviceId
        })
    });
}

// Set latency
async function setLatency(deviceId, latencyMs) {
    await fetch('/api/latency/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_id: deviceId,
            latency_ms: latencyMs
        })
    });
}

// Set frequency cutoff filter
async function setFilter(deviceId, lowCutoff, highCutoff) {
    await fetch('/api/filter/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_id: deviceId,
            low_cutoff: lowCutoff,
            high_cutoff: highCutoff
        })
    });
}

// WebSocket connection
function connectWebSocket() {
    ws = new WebSocket(`ws://${window.location.host}/ws`);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'levels') {
            // Update input levels
            if (inputNode) {
                inputNode.levels = data.input_levels;
            }

            // Update output levels
            for (let deviceId in data.output_levels) {
                const node = outputNodes[deviceId];
                if (node) {
                    node.levels = data.output_levels[deviceId];
                }
            }
        }
    };

    ws.onclose = () => {
        console.log('WebSocket closed');
    };
}


// --- Caching System ---

function saveGraphToCache() {
    // Only save if we have nodes (avoid saving empty state on clean load)
    if (graph._nodes.length > 0) {
        const data = graph.serialize();
        localStorage.setItem('audio_router_graph', JSON.stringify(data));
    }
}

function restoreGraphFromCache() {
    const dataStr = localStorage.getItem('audio_router_graph');
    if (dataStr) {
        try {
            const data = JSON.parse(dataStr);
            graph.configure(data);

            // Re-link global variables to the restored nodes
            const inputs = graph.findNodesByType("audio/input");
            if (inputs.length > 0) {
                inputNode = inputs[0];
            }

            outputNodes = {};
            const outputs = graph.findNodesByType("audio/output");
            outputs.forEach(node => {
                if (node.properties.device_id >= 0) {
                    outputNodes[node.properties.device_id] = node;

                    // Attempt to resync backend for output devices
                    fetch('/api/output/add', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ device_id: node.properties.device_id })
                    }).catch(err => console.error("Failed to resync output device:", err));
                }
            });

            console.log("Graph restored from cache.");
        } catch (e) {
            console.error("Failed to restore graph from cache:", e);
        }
    }
}

// Auto-save every 2 seconds
setInterval(saveGraphToCache, 2000);

// Initialize
loadDevices().then(() => {
    // Restore graph after devices are loaded
    setTimeout(() => {
        restoreGraphFromCache();
        renderDeviceList();
    }, 100);
});

// Resize canvas properly
function resizeCanvas() {
    const container = document.getElementById('canvas-container');
    const canvasEl = document.getElementById('mycanvas');
    canvasEl.width = container.offsetWidth;
    canvasEl.height = container.offsetHeight;
    canvas.resize();
}

window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 100);

// Start graph rendering
graph.start();

// Log devices for easy reference
setTimeout(() => {
    console.log('=== Available Output Devices ===');
    devices.output.forEach(d => {
        console.log(`ID: ${d.id} - ${d.name}`);
    });
}, 500);

<!-- SPDX-License-Identifier: MIT -->
# YPY WebSocket Extension - Interactive Demo

A beautiful, comprehensive demonstration of the `ypy-ws` extension showcasing real-time bidirectional communication with WebSockets.

## 🚀 Quick Start

1. **Serve the repository**:
   ```bash
   go run ./cmd/ypy test --serve --port 8080
   ```

2. **WebSocket backend**: the Node demo server (`ws-server.js`) was removed with the Node
   toolchain and its Go replacement is still pending. Until then the page loads but the
   sockets do not connect; `examples/server` (`go run ./examples/server`) has a working
   WebSocket echo endpoint for the migration apps.

3. **Open your browser**:
   Navigate to `http://localhost:8080/test/manual/ws.html`

## 🎯 What's Included

### 1. **Live Chat**
- Send and receive messages in real-time
- See your messages and bot responses instantly
- Demonstrates `ypy-ws:send` with form submission

### 2. **Live Notifications**
- Receive random notifications every 5-8 seconds
- Shows real-time server push
- Uses `afterbegin` to prepend new notifications

### 3. **Shared Counter**
- Multiple clients share the same counter state
- Increment, decrement, or reset from any client
- All connected clients see updates instantly
- Demonstrates bi-directional communication

### 4. **Stock Ticker**
- Live updating stock prices
- Prices change every 2-3 seconds
- Shows percentage changes with color coding
- Demonstrates continuous server streaming

### 5. **System Dashboard**
- Real-time system metrics (CPU, Memory, Disk)
- Multiple partial updates in a single message
- Updates every second
- Shows using multiple `<ypy-partial>` elements

### 6. **Event Log**
- See all WebSocket events in real-time
- Connection, disconnection, messages, errors
- Demonstrates event listeners for debugging

## 💡 Features Demonstrated

- **Connection Management**: `ypy-ws:connect` with different URLs
- **Message Sending**: `ypy-ws:send` with forms and buttons
- **Partial Updates**: Using `<ypy-partial>` elements for targeted swaps
- **Multiple Connections**: Each demo card maintains its own WebSocket
- **Event Handling**: Custom event listeners for debugging
- **Reconnection**: Automatic reconnection on disconnect (try stopping the server!)
- **Swap Strategies**: Different `ypy-swap` values (innerHTML, beforeend, etc.)

## 🎨 Key Concepts

### HTML Message Format

Server messages use `content` for HTML and may specify a target and serialized swap specification:

```json
{
  "content": "<p>Content</p>",
  "target": "#target-id",
  "swap": "beforeend settle:10ms"
}
```

### Message Flow

Client sends:
```json
{
  "headers": { "YPY-Request": "true" },
  "message": "Hello!"
}
```

Server responds:

```json
{
  "content": "<p>Saved</p>"
}
```

### Multiple Partials

Send multiple updates in one message:

```html
<ypy-partial id="cpu">CPU: 45%</ypy-partial>
<ypy-partial id="memory">Memory: 62%</ypy-partial>
<ypy-partial id="disk">Disk: 73%</ypy-partial>
```

## 🔧 Configuration

The extension respects these config options:

```javascript
ypy.config.ws = {
    reconnect: true,              // Auto-reconnect on disconnect
    reconnectDelay: 500,          // Initial delay (ms)
    reconnectMaxDelay: 60000,     // Max delay (ms)
    reconnectMaxAttempts: Infinity,// Max reconnect attempts
    reconnectJitter: 0.3,         // Jitter factor (0-1)
    pauseOnBackground: true,      // Pause connection when tab is backgrounded
    protocols: null               // Optional WebSocket subprotocols
};
```

## 🎓 Learning Points

1. **Connection Ownership**: Each connection element owns its WebSocket
2. **Bi-directional**: Both client and server can initiate messages
3. **Event-Driven**: Rich event system for monitoring and debugging
4. **Swap Strategies**: Flexible content replacement strategies
5. **Graceful Degradation**: Automatic reconnection and error handling

## 📚 Code Examples

### Basic Connection
```html
<div ypy-ws:connect="ws://localhost:8080/chat" ypy-trigger="load">
    <div id="messages"></div>
</div>
```

### Sending Messages
```html
<form ypy-ws:send ypy-trigger="submit">
    <input name="message" type="text">
    <button type="submit">Send</button>
</form>
```

### Button Actions
```html
<button ypy-ws:send ypy-vals='{"action":"increment"}' ypy-trigger="click">
    Increment
</button>
```

### Multiple Targets
```html
<div ypy-ws:connect="ws://localhost:8080/dashboard" ypy-trigger="load">
    <div id="cpu"></div>
    <div id="memory"></div>
    <div id="disk"></div>
</div>
```

## 🐛 Debugging

The demo includes a live event log that shows:
- Connection events (`ypy:ws:before:connection`, `ypy:ws:after:connection`)
- Outgoing message events (`ypy:ws:before:message:outgoing`, `ypy:ws:after:message:outgoing`)
- Message events (`ypy:ws:before:message:incoming`, `ypy:ws:after:message:incoming`)
- Error events (`ypy:ws:error`, `ypy:ws:close`)

## 🤝 Contributing

Try modifying the demos to learn:
- Change swap strategies (`ypy-swap="beforeend"`)
- Add new message types
- Implement custom channels
- Add authentication
- Create new demo cards

## 📖 Documentation

For full documentation, visit:
- [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)

## 🎉 Have Fun!

Open multiple browser windows to see real-time synchronization in action. The shared counter and chat work across all connected clients!

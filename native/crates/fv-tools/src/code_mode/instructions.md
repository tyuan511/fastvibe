Execute JavaScript to orchestrate tools and reduce large results before printing.
Use {"code":"..."}; code is raw JavaScript inside this JSON field so every supported model protocol can call it. It runs in a fresh QuickJS async module with no Node, process, filesystem, network, console or imported modules. Globals do not persist; store/load values persist in this conversation until restart.

All currently authorized local and MCP tools are on `tools`, including deferred tools; inspect `ALL_TOOLS` ({name, description, schema}) to find one. Names are exact native tool names: `await tools.exec_command({cmd:"pwd"})`. Tool arguments are JSON objects. Tools return their JSON result when valid JSON, otherwise text; tool errors reject the promise. Nested calls obey the same sandbox, approvals and read/write gate as direct calls. Provider-hosted web_search is invoked by the model outside JavaScript, not through tools. Scripts cannot call code_mode or wait recursively. Use `await Promise.all([...])` only for independent calls; await every tool operation you need before the script ends.

Helpers:
- text(value): append a text result; non-strings use JSON.stringify.
- audio(dataUrlOrObject): append a base64 audio clip (`audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/webm`, `audio/mp4`, `audio/aac`; 16 MiB encoded maximum, 4 clips per batch).
- image(dataUrlOrMcpImage): append a base64 data URL or MCP {type:"image",data,mimeType} image. Tool results with images expose an `images` array; print only the ones you need.
- generatedImage({image_url,output_hint}): append an image and optional text.
- store(key,value) / load(key): keep JSON values across cells in this conversation (128 keys / 1 MiB).
- notify(value): append text and yield the current output immediately while execution continues.
- yield_control(): return accumulated output immediately while execution continues.
- setTimeout(callback,ms) / clearTimeout(id): timers; an unawaited timer never keeps a completed script alive.
- exit(): finish successfully immediately, discarding remaining work.

Only printed text/images reach the model. Pending tool calls are cancelled when the script ends. A cell can yield: use `wait` with the returned cell_id to collect only new output or terminate it. Finish or terminate cells before your final answer; remaining cells are cancelled at the end of the turn. First-line `// @exec: {"yield_time_ms":1000,"max_output_tokens":2000}` is optional; explicit JSON arguments take precedence. Default yield: 10000 ms; max: 300000. Cells have a 64 MiB JS heap, 512 KiB JS stack, 10-minute wall limit, 1 MiB unread text, and at most eight unread images (8 MiB each / 16 MiB combined). At most four live cells per conversation, sixteen globally; each cell allows 256 tool calls total, 16 concurrently, and 1 MiB of arguments per call. Prefer printing compact summaries; large output is truncated to the requested token budget (default 10000, max 50000).

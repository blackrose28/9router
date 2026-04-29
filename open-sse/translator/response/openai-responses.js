/**
 * Translator: OpenAI Chat Completions → OpenAI Responses API (response)
 * Converts streaming chunks from Chat Completions to Responses API events
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";

/**
 * Translate OpenAI chunk to Responses API events
 * @returns {Array} Array of events with { event, data } structure
 */
export function openaiToOpenAIResponsesResponse(chunk, state) {
  if (!chunk) {
    return flushEvents(state);
  }
  
  if (!chunk.choices?.length) return [];
  
  const events = [];
  const nextSeq = () => ++state.seq;
  
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  const choice = chunk.choices[0];
  const idx = choice.index || 0;
  const delta = choice.delta || {};

  // Emit initial events
  if (!state.started) {
    state.started = true;
    state.responseId = chunk.id ? `resp_${chunk.id}` : state.responseId;
    state.model = chunk.model || state.model || "unknown";
    
    emit("response.created", {
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        model: state.model,
        status: "in_progress",
        background: false,
        error: null,
        output: []
      }
    });

    emit("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress"
      }
    });
  }

  // Handle reasoning_content
  if (delta.reasoning_content) {
    // Close any open message block before starting (new) reasoning
    for (const i in state.msgItemAdded) closeMessage(state, emit, i);
    startReasoning(state, emit, idx);
    emitReasoningDelta(state, emit, delta.reasoning_content);
  }

  // Handle text content
  if (delta.content) {
    // Close any open reasoning block before emitting text (for reasoning_content → content transition)
    closeReasoning(state, emit);
    let content = delta.content;

    // Process all <think>...</think> pairs in the content (handles multiple pairs per chunk)
    while (content.includes("<think>") || content.includes("</think>")) {
      if (!state.inThinking && content.includes("<think>")) {
        // Text before <think> tag
        const beforeThink = content.substring(0, content.indexOf("<think>"));
        if (beforeThink) emitTextContent(state, emit, idx, beforeThink);
        
        state.inThinking = true;
        content = content.substring(content.indexOf("<think>") + 7);
        startReasoning(state, emit, idx);
      }

      if (state.inThinking && content.includes("</think>")) {
        const parts = content.split("</think>");
        const thinkPart = parts[0];
        if (thinkPart) emitReasoningDelta(state, emit, thinkPart);
        closeReasoning(state, emit);
        state.inThinking = false;
        content = parts.slice(1).join("</think>");
      } else {
        // No closing tag yet — remaining content is reasoning delta
        break;
      }
    }

    if (state.inThinking && content) {
      emitReasoningDelta(state, emit, content);
      return events;
    }

    if (content) {
      emitTextContent(state, emit, idx, content);
    }
  }

  // Handle tool_calls
  if (delta.tool_calls) {
    closeMessage(state, emit, idx);
    for (const tc of delta.tool_calls) {
      emitToolCall(state, emit, tc);
    }
  }

  // Handle finish_reason
  if (choice.finish_reason) {
    // Capture usage from final chunk (OpenAI includes usage in finish chunk)
    if (chunk.usage) {
      state.completedUsage = {
        input_tokens: chunk.usage.prompt_tokens || 0,
        output_tokens: chunk.usage.completion_tokens || 0,
        total_tokens: chunk.usage.total_tokens || 0
      };
    }
    for (const i in state.msgItemAdded) closeMessage(state, emit, i);
    closeReasoning(state, emit);
    for (const i in state.funcCallIds) closeToolCall(state, emit, i);
    sendCompleted(state, emit);
  }

  return events;
}

// Helper functions
function startReasoning(state, emit, idx) {
  if (!state.reasoningId) {
    const outputIdx = state.nextOutputIndex++;
    state.reasoningId = `rs_${state.responseId}_${idx}`;
    state.reasoningIndex = outputIdx;
    
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIdx,
      item: { id: state.reasoningId, type: "reasoning", summary: [] }
    });

    emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: state.reasoningId,
      output_index: outputIdx,
      summary_index: 0,
      part: { type: "summary_text", text: "" }
    });
    state.reasoningPartAdded = true;
  }
}

function emitReasoningDelta(state, emit, text) {
  if (!text) return;
  state.reasoningBuf += text;
  emit("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    delta: text
  });
}

function closeReasoning(state, emit) {
  if (state.reasoningId && !state.reasoningDone) {
    state.reasoningDone = true;
    
    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      text: state.reasoningBuf
    });

    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: state.reasoningBuf }
    });

    const reasoningItem = {
      id: state.reasoningId,
      type: "reasoning",
      summary: [{ type: "summary_text", text: state.reasoningBuf }]
    };

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item: reasoningItem
    });

    // Track for response.completed output array
    state.completedOutputItems.push(reasoningItem);
  }

  // Reset reasoning state so a new reasoning block can be created
  // (e.g. model sends reasoning → content → reasoning again)
  if (state.reasoningDone) {
    state.reasoningId = "";
    state.reasoningDone = false;
    state.reasoningBuf = "";
    state.reasoningPartAdded = false;
    state.reasoningIndex = -1;
  }
}

function emitTextContent(state, emit, idx, content) {
  if (!state.msgItemAdded[idx]) {
    state.msgItemAdded[idx] = true;
    if (!state.msgOutputIndex) state.msgOutputIndex = {};
    state.msgOutputIndex[idx] = state.nextOutputIndex++;
    const msgId = `msg_${state.responseId}_${idx}`;
    
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.msgOutputIndex[idx],
      item: { id: msgId, type: "message", content: [], role: "assistant" }
    });
  }

  const msgOutIdx = state.msgOutputIndex?.[idx] ?? idx;

  if (!state.msgContentAdded[idx]) {
    state.msgContentAdded[idx] = true;
    
    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${state.responseId}_${idx}`,
      output_index: msgOutIdx,
      content_index: 0,
      part: { type: "output_text", annotations: [], logprobs: [], text: "" }
    });
  }

  emit("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `msg_${state.responseId}_${idx}`,
    output_index: msgOutIdx,
    content_index: 0,
    delta: content,
    logprobs: []
  });

  if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
  state.msgTextBuf[idx] += content;
}

function closeMessage(state, emit, idx) {
  if (state.msgItemAdded[idx] && !state.msgItemDone[idx]) {
    state.msgItemDone[idx] = true;
    const fullText = state.msgTextBuf[idx] || "";
    const msgId = `msg_${state.responseId}_${idx}`;
    const msgOutIdx = state.msgOutputIndex?.[idx] ?? parseInt(idx);

    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: msgOutIdx,
      content_index: 0,
      text: fullText,
      logprobs: []
    });

    emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: msgId,
      output_index: msgOutIdx,
      content_index: 0,
      part: { type: "output_text", annotations: [], logprobs: [], text: fullText }
    });

    const messageItem = {
      id: msgId,
      type: "message",
      content: [{ type: "output_text", annotations: [], logprobs: [], text: fullText }],
      role: "assistant"
    };

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: msgOutIdx,
      item: messageItem
    });

    // Track for response.completed output array
    state.completedOutputItems.push(messageItem);
  }
}

function emitToolCall(state, emit, tc) {
  const tcIdx = tc.index ?? 0;
  const newCallId = tc.id;
  const funcName = tc.function?.name;

  if (funcName) state.funcNames[tcIdx] = funcName;

  if (!state.funcCallIds[tcIdx] && newCallId) {
    state.funcCallIds[tcIdx] = newCallId;
    if (!state.funcOutputIndex) state.funcOutputIndex = {};
    state.funcOutputIndex[tcIdx] = state.nextOutputIndex++;
    
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.funcOutputIndex[tcIdx],
      item: {
        id: `fc_${newCallId}`,
        type: "function_call",
        arguments: "",
        call_id: newCallId,
        name: state.funcNames[tcIdx] || ""
      }
    });
  }

  if (!state.funcArgsBuf[tcIdx]) state.funcArgsBuf[tcIdx] = "";

  if (tc.function?.arguments) {
    const refCallId = state.funcCallIds[tcIdx] || newCallId;
    if (refCallId) {
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: `fc_${refCallId}`,
        output_index: state.funcOutputIndex?.[tcIdx] ?? tcIdx,
        delta: tc.function.arguments
      });
    }
    state.funcArgsBuf[tcIdx] += tc.function.arguments;
  }
}

function closeToolCall(state, emit, idx) {
  const callId = state.funcCallIds[idx];
  if (callId && !state.funcItemDone[idx]) {
    const args = state.funcArgsBuf[idx] || "{}";
    const funcOutIdx = state.funcOutputIndex?.[idx] ?? parseInt(idx);
    
    emit("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: `fc_${callId}`,
      output_index: funcOutIdx,
      arguments: args
    });

    const toolCallItem = {
      id: `fc_${callId}`,
      type: "function_call",
      arguments: args,
      call_id: callId,
      name: state.funcNames[idx] || ""
    };

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: funcOutIdx,
      item: toolCallItem
    });

    // Track for response.completed output array
    state.completedOutputItems.push(toolCallItem);

    state.funcItemDone[idx] = true;
    state.funcArgsDone[idx] = true;
  }
}

function sendCompleted(state, emit) {
  if (!state.completedSent) {
    state.completedSent = true;
    const response = {
      id: state.responseId,
      object: "response",
      created_at: state.created,
      model: state.model || "unknown",
      status: "completed",
      background: false,
      error: null,
      output: state.completedOutputItems || []
    };
    if (state.completedUsage) {
      response.usage = state.completedUsage;
    }
    emit("response.completed", {
      type: "response.completed",
      response
    });
  }
}

function flushEvents(state) {
  if (state.completedSent) return [];
  
  const events = [];
  const nextSeq = () => ++state.seq;
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  for (const i in state.msgItemAdded) closeMessage(state, emit, i);
  closeReasoning(state, emit);
  for (const i in state.funcCallIds) closeToolCall(state, emit, i);
  sendCompleted(state, emit);
  
  return events;
}

// currentToolCallId is intentionally sticky for the current turn so flush/completion
  // can still finalize as tool_calls even if the tool call was emitted before stream end.
function computeFinishReason(state) {
   return state.toolCallIndex > 0 || state.currentToolCallId
    ? "tool_calls"
    : "stop";
}

/**
 * Translate OpenAI Responses API chunk to OpenAI Chat Completions format
 * This is for when Codex returns data and we need to send it to an OpenAI-compatible client
 */
export function openaiResponsesToOpenAIResponse(chunk, state) {
  if (!chunk) {
    // Flush: send final chunk with finish_reason
    if (state.finishReasonSent || !state.started) return null;

    const finishReason = computeFinishReason(state);

    state.finishReasonSent = true;
    state.finishReason = finishReason;

    const finalChunk = {
      id: state.chatId || `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: state.created || Math.floor(Date.now() / 1000),
      model: state.model || "unknown",
      choices: [{
        index: 0,
        delta: {},
        finish_reason: finishReason
      }]
    };

    if (state.usage && typeof state.usage === "object") {
      finalChunk.usage = state.usage;
    }

    return finalChunk;
  }

  // Handle different event types from Responses API
  const eventType = chunk.type || chunk.event;
  const data = chunk.data || chunk;

  // Initialize state
  if (!state.started) {
    state.started = true;
    state.chatId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.toolCallIndex = 0;
    state.currentToolCallId = null;
  }

  // Text content delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;

    return {
      id: state.chatId,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model || "unknown",
      choices: [{
        index: 0,
        delta: { content: delta },
        finish_reason: null
      }]
    };
  }

  // Text content done (ignore, we handle via delta)
  if (eventType === "response.output_text.done") {
    return null;
  }

  // Function call started (standard function_call or custom_tool_call)
  if (eventType === "response.output_item.added" && (data.item?.type === "function_call" || data.item?.type === "custom_tool_call")) {
    const item = data.item;
    state.currentToolCallId = item.call_id || `call_${Date.now()}`;

    return {
      id: state.chatId,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model || "unknown",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: state.toolCallIndex,
            id: state.currentToolCallId,
            type: "function",
            function: {
              name: item.name || "",
              arguments: ""
            }
          }]
        },
        finish_reason: null
      }]
    };
  }

  // Function call arguments delta (standard or custom_tool_call variant)
  if (eventType === "response.function_call_arguments.delta" || eventType === "response.custom_tool_call_input.delta") {
    const argsDelta = data.delta || "";
    if (!argsDelta) return null;

    return {
      id: state.chatId,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model || "unknown",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: state.toolCallIndex,
            function: { arguments: argsDelta }
          }]
        },
        finish_reason: null
      }]
    };
  }

  // Function call done (standard or custom_tool_call variant)
  if (eventType === "response.output_item.done" && (data.item?.type === "function_call" || data.item?.type === "custom_tool_call")) {
    state.toolCallIndex++;
    return null;
  }

  // Response completed
  if (eventType === "response.completed") {
    // Extract usage from response.completed event
    const responseUsage = data.response?.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const inputTokens = responseUsage.input_tokens || responseUsage.prompt_tokens || 0;
      const outputTokens = responseUsage.output_tokens || responseUsage.completion_tokens || 0;
      // OpenAI Responses API: input_tokens already includes cached_tokens
      // Cache info is in input_tokens_details.cached_tokens
      const cacheReadTokens = responseUsage.input_tokens_details?.cached_tokens || responseUsage.cache_read_input_tokens || 0;
      
      state.usage = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      };
      
      // Add prompt_tokens_details if cache tokens exist
      if (cacheReadTokens > 0) {
        state.usage.prompt_tokens_details = {
          cached_tokens: cacheReadTokens
        };
      }
    }
    
    if (!state.finishReasonSent) {
      const finishReason = computeFinishReason(state);

      state.finishReasonSent = true;
      state.finishReason = finishReason; // Mark for usage injection in stream.js
      
      const finalChunk = {
        id: state.chatId,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model || "unknown",
        choices: [{
          index: 0,
          delta: {},
          finish_reason: finishReason
        }]
      };
      
      // Include usage in final chunk if available
      if (state.usage && typeof state.usage === "object") {
        finalChunk.usage = state.usage;
      }
      
      return finalChunk;
    }
    return null;
  }

  // Error events from Responses API (e.g. model_not_found)
  if (eventType === "error" || eventType === "response.failed") {
    // Avoid emitting duplicate errors (error + response.failed arrive back-to-back)
    if (state.finishReasonSent) return null;

    const error = data.error || data.response?.error;
    if (error) {
      state.error = error;
      state.finishReasonSent = true;

      // Surface the error as an OpenAI-compatible error chunk
      return {
        id: state.chatId || `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: state.created || Math.floor(Date.now() / 1000),
        model: state.model || "unknown",
        choices: [{
          index: 0,
          delta: { content: `[Error] ${error.message || JSON.stringify(error)}` },
          finish_reason: "stop"
        }]
      };
    }
    return null;
  }

  // Reasoning events (convert to content or skip)
  if (eventType === "response.reasoning_summary_text.delta") {
    // Optionally include reasoning as content, or skip
    return null;
  }

  // Ignore other events
  return null;
}

// Register both directions
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, openaiToOpenAIResponsesResponse);
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, null, openaiResponsesToOpenAIResponse);

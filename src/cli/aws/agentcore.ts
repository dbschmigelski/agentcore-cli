import { getCredentialProvider } from './account';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';

export interface InvokeAgentRuntimeOptions {
  region: string;
  runtimeArn: string;
  payload: string;
}

/**
 * Parse a single SSE data line and extract the content.
 * Returns null if the line is not a data line or contains an error.
 */
function parseSSELine(line: string): { content: string | null; error: string | null } {
  if (!line.startsWith('data: ')) {
    return { content: null, error: null };
  }
  const content = line.slice(6);
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'string') {
      return { content: parsed, error: null };
    } else if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return { content: null, error: String((parsed as { error: unknown }).error) };
    }
  } catch {
    return { content, error: null };
  }
  return { content: null, error: null };
}

/**
 * Parse SSE response into combined text.
 */
function parseSSE(text: string): string {
  const parts: string[] = [];
  for (const line of text.split('\n')) {
    const { content, error } = parseSSELine(line);
    if (error) {
      return `Error: ${error}`;
    }
    if (content) {
      parts.push(content);
    }
  }
  return parts.join('');
}

/**
 * Extract result from a JSON response object.
 * Handles both {"result": "..."} and plain text responses.
 */
function extractResult(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'result' in parsed) {
      const result = (parsed as { result: unknown }).result;
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    }
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

/**
 * Invoke an AgentCore Runtime and stream the response chunks.
 * Yields text chunks as they arrive from the SSE stream.
 */
export async function* invokeAgentRuntimeStreaming(
  options: InvokeAgentRuntimeOptions
): AsyncGenerator<string, void, unknown> {
  const client = new BedrockAgentCoreClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: options.runtimeArn,
    payload: new TextEncoder().encode(JSON.stringify({ prompt: options.payload })),
    contentType: 'application/json',
    accept: 'application/json',
  });

  const response = await client.send(command);

  if (!response.response) {
    throw new Error('No response from AgentCore Runtime');
  }

  const webStream = response.response.transformToWebStream();
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let yieldedContent = false;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;

      const decoded = decoder.decode(result.value as Uint8Array, { stream: true });
      buffer += decoded;
      fullResponse += decoded;

      // Process complete lines from the buffer
      const lines = buffer.split('\n');
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const { content, error } = parseSSELine(line);
        if (error) {
          yield `Error: ${error}`;
          return;
        }
        if (content) {
          yield content;
          yieldedContent = true;
        }
      }
    }

    // Process any remaining content in the buffer for SSE
    if (buffer) {
      const { content, error } = parseSSELine(buffer);
      if (error) {
        yield `Error: ${error}`;
        return;
      } else if (content) {
        yield content;
        yieldedContent = true;
      }
    }

    // If no SSE content was found, treat as plain JSON response
    if (!yieldedContent && fullResponse.trim()) {
      yield extractResult(fullResponse.trim());
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Invoke an AgentCore Runtime and return the response.
 */
export async function invokeAgentRuntime(options: InvokeAgentRuntimeOptions): Promise<string> {
  const client = new BedrockAgentCoreClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: options.runtimeArn,
    payload: new TextEncoder().encode(JSON.stringify({ prompt: options.payload })),
    contentType: 'application/json',
    accept: 'application/json',
  });

  const response = await client.send(command);

  if (!response.response) {
    throw new Error('No response from AgentCore Runtime');
  }

  const bytes = await response.response.transformToByteArray();
  const text = new TextDecoder().decode(bytes);

  // Parse SSE format if present
  if (text.includes('data: ')) {
    return parseSSE(text);
  }

  // Handle plain JSON response (non-streaming frameworks)
  return extractResult(text);
}

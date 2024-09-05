// TODO [ryanhopperlowe] refactor this file to create a separate state for loadingChat so that
// it doesn't recreate the entire chat state on every chunk of generated text
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  AuthResponse,
  Block,
  CallFrame,
  Frame,
  PromptFrame,
  PromptResponse,
} from '@gptscript-ai/gptscript';
import { Message, MessageType } from './messages';
import PromptForm from './messages/promptForm';
import ConfirmForm from './messages/confirmForm';
import { rootTool, stringify } from '@/actions/gptscript';
import { updateScript } from '@/actions/me/scripts';
import { gatewayTool } from '@/actions/knowledge/util';

const CHUNK_SIZE = 1024;

function chunkData(data: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    chunks.push(data.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

function reassembleChunks(chunks: string[]): string {
  return chunks.join('');
}

const useChatSocket = (isEmpty?: boolean) => {
  const initiallyTrustedRepos = [
    'github.com/gptscript-ai/context',
    'github.com/gptscript-ai/gateway-provider',
    'github.com/gptscript-ai/gateway-creds',
    'github.com/gptscript-ai/gateway-oauth2',
    'github.com/gptscript-ai/knowledge',
    'github.com/gptscript-ai/answers-from-the-internet',
    'github.com/gptscript-ai/search-website',
    'github.com/gptscript-ai/tools/apis/hubspot/crm/read',
  ];
  // State
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [latestAgentMessage, setLatestAgentMessage] = useState<Message>(
    {} as Message
  );
  const [generating, setGenerating] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [forceRun, setForceRun] = useState(false);
  const [scriptContent, setScriptContent] = useState<Block[]>([]);
  const [waitingForUserResponse, setWaitingForUserResponse] = useState(false);

  // Refs
  const socketRef = useRef<Socket | null>(null);
  const messagesRef = useRef(messages);
  const latestAgentMessageRef = useRef(latestAgentMessage);
  const trustedRef = useRef<Record<string, boolean>>({});
  const trustedRepoPrefixesRef = useRef<string[]>([...initiallyTrustedRepos]);
  // trustedOpenAPIRef contains a mapping of OpenAPI run tools to OpenAPI operation names that have been trusted.
  const trustedOpenAPIRef = useRef<Record<string, Record<string, boolean>>>({});

  // update the refs as the state changes
  messagesRef.current = messages;
  socketRef.current = socket;
  latestAgentMessageRef.current = latestAgentMessage;

  const handleError = useCallback((error: string) => {
    setGenerating(false);
    setWaitingForUserResponse(false);
    setError(error);
    setMessages((prevMessages) => {
      if (!latestAgentMessageRef.current.type) {
        // If there are no previous messages, create a new error message
        return [
          ...prevMessages,
          {
            type: MessageType.Agent,
            name: '',
            message:
              'The script encountered an error. You can either restart the script or try to continue chatting.',
            error,
          },
        ];
      }

      latestAgentMessage.error = `${error}`;
      setLatestAgentMessage({} as Message);
      return [...prevMessages, { ...latestAgentMessage }];
    });
  }, []);

  // handles progress being received from the server (callProgress style frames).
  const handleProgress = useCallback(
    ({ frame, name }: { frame: Frame; name?: string }) => {
      if (!latestAgentMessageRef.current.type)
        latestAgentMessageRef.current.type = MessageType.Agent;
      if (!latestAgentMessageRef.current.name)
        latestAgentMessageRef.current.name = name;
      if (latestAgentMessageRef.current.component)
        latestAgentMessageRef.current.component = null;

      if (!frame.type.startsWith('call')) {
        if (frame.type === 'runStart') {
          latestAgentMessageRef.current.message =
            'Waiting for model response...';
          setLatestAgentMessage({ ...latestAgentMessageRef.current });
        }
        return;
      }

      // At this point, we know that we are dealing with a call frame
      frame = frame as CallFrame;
      if (!latestAgentMessageRef.current.calls) {
        latestAgentMessageRef.current.calls = {};
      }
      latestAgentMessageRef.current.calls[frame.id] = frame;

      if (!frame.error && frame.toolCategory === 'provider') {
        return;
      }

      const isMainContent =
        frame?.output &&
        frame.output.length > 0 &&
        (!frame.parentID || frame.tool?.chat) &&
        !frame.output[frame.output.length - 1].subCalls;

      let content = isMainContent
        ? frame.output[frame.output.length - 1].content || ''
        : '';
      if (!content) return;
      setGenerating(true);
      if (
        content === 'Waiting for model response...' &&
        latestAgentMessageRef.current.message
      )
        return;

      if (content.startsWith('<tool call>')) {
        const parsedToolCall = parseToolCall(content);
        content = `Calling tool ${parsedToolCall.tool}...`;
      }

      latestAgentMessageRef.current.message = content;

      if (isMainContent && frame.type == 'callFinish') {
        setMessages([
          ...messagesRef.current,
          { ...latestAgentMessageRef.current },
        ]);
        setLatestAgentMessage({} as Message);
        setGenerating(false);
      } else {
        setLatestAgentMessage({ ...latestAgentMessageRef.current });
      }
    },
    []
  );

  const handlePromptRequest = useCallback(
    ({ frame, name }: { frame: PromptFrame; name?: string }) => {
      setWaitingForUserResponse(true);
      setLatestAgentMessage((prev) => {
        prev.name = name;
        prev.message =
          frame.metadata &&
          frame.metadata.authURL &&
          frame.metadata.toolDisplayName
            ? `${frame.metadata.toolDisplayName} requires authentication`
            : frame.message;
        prev.component = (
          <PromptForm
            frame={frame}
            onSubmit={(response: PromptResponse) => {
              socketRef.current?.emit('promptResponse', response);
              setWaitingForUserResponse(false);
            }}
          />
        );
        return { ...prev };
      });
    },
    []
  );

  const handleConfirmRequest = useCallback(
    ({ frame, name }: { frame: CallFrame; name?: string }) => {
      if (!frame.tool) return;

      if (alreadyAllowed(frame)) {
        socketRef.current?.emit('confirmResponse', {
          id: frame.id,
          accept: true,
        });
        return;
      }
      setWaitingForUserResponse(true);
      let confirmMessage = `Proceed with calling the ${frame.tool.name} tool?`;
      if (frame.tool.instructions?.startsWith('#!sys.openapi')) {
        confirmMessage = `Proceed with running the following API operation (or allow all runs of this operation)?`;
      } else if (frame.displayText) {
        const tool = frame.tool?.name?.replace('sys.', '');
        confirmMessage = frame.tool?.source?.repo
          ? `Proceed with running the following (or allow all calls from the **${trimRepo(frame.tool?.source.repo!.Root)}** repo)?`
          : `Proceed with running the following (or allow all **${tool}** calls)?`;
      }

      setLatestAgentMessage((prev) => {
        prev.component = (
          <ConfirmForm
            id={frame.id}
            message={confirmMessage}
            command={frame.displayText}
            tool={frame.tool?.name || 'main'}
            addTrusted={addTrustedFor(frame)}
            onSubmit={(response: AuthResponse) => {
              socketRef.current?.emit('confirmResponse', response);
              setWaitingForUserResponse(false);
            }}
          />
        );

        prev.name = name;
        return { ...prev };
      });
    },
    []
  );

  const handleToolChange = async (
    tools: string[],
    scriptId?: string,
    scriptContent?: Block[]
  ) => {
    setTools(tools);
    if (scriptContent) {
      // Ensure the knowledge tool isn't set.
      const tool = await rootTool(scriptContent);
      tool.tools = (tool.tools || []).filter((t) => t !== gatewayTool());
      setScriptContent(scriptContent);
      if (scriptId) {
        const content = await stringify(scriptContent);
        await updateScript({
          content: content,
          id: parseInt(scriptId),
        });
      }
    }
    setRunning(true);
  };

  const parseToolCall = (
    toolCall: string
  ): { tool: string; params: string } => {
    const [tool, params] = toolCall.replace('<tool call> ', '').split(' -> ');
    return { tool, params };
  };

  const trimRepo = (repo: string): string => {
    return repo
      .replace('https://', '')
      .replace('http://', '')
      .replace('.git', '');
  };

  const alreadyAllowed = (frame: CallFrame): boolean => {
    if (!frame.tool) return false;

    if (frame.tool.instructions?.startsWith('#!sys.openapi')) {
      // If the tool is an OpenAPI tool to list operations or get the schema for an operation, allow it.
      const instructions = frame.tool.instructions.split(' ');
      if (
        instructions.length > 2 &&
        (instructions[1] == 'list' || instructions[1] == 'get-schema')
      ) {
        return true;
      }

      // If the tool is an OpenAPI tool to run an operation, check if it has been trusted.
      if (!frame.tool.name) {
        return false;
      }

      const operation = JSON.parse(frame.input as string)['operation'];
      return (
        trustedOpenAPIRef.current[frame.tool.name] &&
        trustedOpenAPIRef.current[frame.tool.name][operation]
      );
    }

    // Check if the tool has already been allowed
    if (frame.tool.name && trustedRef.current[frame.tool.name]) return true;

    // If this tool have a source repo, check if it is trusted. If it isn't already,
    // return false since we need to ask the user for permission.
    if (frame.tool.source?.repo) {
      const repo = frame.tool?.source.repo.Root;
      const trimmedRepo = trimRepo(repo);

      // If it is a read-only tool we've authored, auto-allow it.
      if (
        trimmedRepo.startsWith('github.com/gptscript-ai') &&
        (frame.tool.name?.startsWith('list') ||
          frame.tool.name?.startsWith('get') ||
          frame.tool.name?.startsWith('read') ||
          frame.tool.name?.startsWith('search'))
      ) {
        return true;
      }

      for (const prefix of trustedRepoPrefixesRef.current) {
        if (trimmedRepo.startsWith(prefix)) {
          return true;
        }
      }
      return false;
    }

    // If the tool is a system tool and wasn't already trusted, return false.
    if (frame.tool?.name?.startsWith('sys.')) return false;

    // Automatically allow all other tools
    return true;
  };

  const addTrustedFor = (frame: CallFrame) => {
    if (!frame.tool) return () => {};

    if (
      frame.tool.instructions &&
      frame.tool.name &&
      frame.tool.instructions.startsWith('#!sys.openapi')
    ) {
      return () => {
        const toolName = frame.tool?.name ?? ''; // Not possible for this to be null, but I have to satisfy the type checker.
        const operation = JSON.parse(frame.input as string)['operation'];

        if (!trustedOpenAPIRef.current[toolName]) {
          trustedOpenAPIRef.current[toolName] = {};
        }
        trustedOpenAPIRef.current[toolName][operation] = true;
      };
    }

    return frame.tool.source?.repo
      ? () => {
          const repo = frame.tool!.source?.repo!.Root;
          const trimmedRepo = trimRepo(repo || '');
          trustedRepoPrefixesRef.current.push(trimmedRepo);
        }
      : () => {
          if (frame.tool?.name) trustedRef.current[frame.tool.name] = true;
        };
  };

  // Store chunks for reassembly
  const receivedChunks = useRef<Record<string, string[]>>({});

  const loadSocket = () => {
    const socket = io();

    // Wrap emit to only chunk data for specific events
    const originalEmit = socket.emit.bind(socket);
    socket.emit = (event: string, data: any) => {
      if (event === 'run' || event === 'userMessage') {
        const isObject = typeof data === 'object';
        const dataString = isObject ? JSON.stringify(data) : data;

        if (dataString?.length > CHUNK_SIZE) {
          const chunks = chunkData(dataString);
          chunks.forEach((chunk, index) => {
            originalEmit(event, { chunk, index, total: chunks.length, isObject });
          });
        } else {
          originalEmit(event, { data: dataString, isObject });
        }
      } else {
        originalEmit(event, data);
      }

      return socket;
    };

    // Wrap on to handle chunked and non-chunked data
    const originalOn = socket.on.bind(socket);
    socket.on = (event: string, callback: (...args: any[]) => void): Socket => {
      originalOn(event, (data: any) => {
        if (data === undefined || typeof data !== 'object') {
          return callback(data); // Pass through for non-chunked data
        }

        const { chunk, index, total, isObject } = data || {};

        // Handle chunked data
        if (chunk !== undefined && index !== undefined && total !== undefined) {
          if (!receivedChunks.current[event]) {
            receivedChunks.current[event] = [];
          }
          receivedChunks.current[event][index] = chunk;

          const receivedLength = receivedChunks.current[event].filter(Boolean).length;
          if (receivedLength === total) {
            let reassembledData = reassembleChunks(receivedChunks.current[event]);
            if (isObject) {
              try {
                reassembledData = JSON.parse(reassembledData);
              } catch (e) {
                console.error('Failed to parse reassembled data');
              }
            }
            callback(reassembledData);
            delete receivedChunks.current[event];
          }
        } else if (data?.data !== undefined) {
          const finalData = isObject ? JSON.parse(data.data) : data.data;
          callback(finalData);
        } else {
          callback(data); // Handle non-chunked data
        }
      });

      return socket;
    };

    socket.off('connect');
    socket.off('disconnect');
    socket.off('running');
    socket.off('interrupted');
    socket.off('progress');
    socket.off('error');
    socket.off('AgentMessage');
    socket.off('promptRequest');
    socket.off('confirmRequest');
    socket.off('toolAdded');
    socket.off('toolRemoved');
    socket.off('scriptSaved');

    setConnected(false);
    setMessages([]);

    socket.on('connect', () => {
      setConnected(true);
    });
    socket.on('disconnect', (reason) => {
      console.log('client socket disconnect: ' + reason);
      setConnected(false);
      setForceRun(true);
    });
    socket.on('running', () => setRunning(true));
    socket.on('interrupted', () => {
      setGenerating(false);
      setWaitingForUserResponse(false);
    });
    socket.on('progress', (data: { frame: Frame; name?: string }) =>
      handleProgress(data)
    );
    socket.on('error', (data: string) => handleError(data));
    socket.on('promptRequest', (data: { frame: PromptFrame; name?: string }) =>
      handlePromptRequest(data)
    );
    socket.on('confirmRequest', (data: { frame: CallFrame; name?: string }) =>
      handleConfirmRequest(data)
    );
    socket.on('toolAdded', (tools: string[]) => handleToolChange(tools));
    socket.on('toolRemoved', (tools: string[]) => handleToolChange(tools));
    socket.on(
      'scriptSaved',
      (scriptId: string, script: Block[], tools: string[]) =>
        handleToolChange(tools, scriptId, script)
    );
    socket.on(
      'loaded',
      (data: {
        messages: Message[];
        tools: string[];
        scriptContent: Block[];
      }) => {
        setScriptContent(data.scriptContent);
        setMessages(data.messages);
        setTools(data.tools);
      }
    );

    setSocket(socket);
  };

  useEffect(() => {
    loadSocket();
  }, []);

  const restart = useCallback(() => {
    setRunning(false);
    interrupt();
    trustedRef.current = {};
    setMessages([]);
    trustedRepoPrefixesRef.current = [...initiallyTrustedRepos];
    loadSocket();
    setError(null);
  }, [socket]);

  const interrupt = useCallback(() => {
    if (!socket || !connected) return;
    socket.emit('interrupt');
  }, [socket, connected]);

  useEffect(() => {
    if (running && messages.length === 0) {
      if (!isEmpty) {
        setLatestAgentMessage({
          calls: {},
          type: MessageType.Agent,
          message: 'Waiting for model response...',
        });
      }
    }
  }, [running, messages, isEmpty]);

  return {
    error,
    socket,
    setSocket,
    connected,
    setConnected,
    latestAgentMessage,
    messages,
    setMessages,
    restart,
    interrupt,
    generating,
    running,
    setRunning,
    tools,
    setTools,
    scriptContent,
    setScriptContent,
    forceRun,
    setForceRun,
    waitingForUserResponse,
  };
};

export default useChatSocket;

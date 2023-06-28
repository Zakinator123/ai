import { useSWR } from 'sswr'
import { Readable, get, writable } from 'svelte/store'

import { Writable } from 'svelte/store'

import type {
  Message,
  CreateMessage,
  UseChatOptions,
  ChatRequestOptions,
  ChatRequest
} from '../shared/types'
import { nanoid, createChunkDecoder } from '../shared/utils'
import { ChatCompletionRequestMessageFunctionCall } from 'openai-edge'

export type { Message, CreateMessage, UseChatOptions }

export type UseChatHelpers = {
  /** Current messages in the chat */
  messages: Readable<Message[]>
  /** The error object of the API request */
  error: Readable<undefined | Error>
  /**
   * Append a user message to the chat list. This triggers the API call to fetch
   * the assistant's response.
   */
  append: (
    message: Message | CreateMessage,
    options?: ChatRequestOptions
  ) => Promise<string | null | undefined>
  /**
   * Reload the last AI chat response for the given chat history. If the last
   * message isn't from the assistant, it will request the API to generate a
   * new response.
   */
  reload: (options?: ChatRequestOptions) => Promise<string | null | undefined>
  /**
   * Abort the current request immediately, keep the generated tokens if any.
   */
  stop: () => void
  /**
   * Update the `messages` state locally. This is useful when you want to
   * edit the messages on the client, and then trigger the `reload` method
   * manually to regenerate the AI response.
   */
  setMessages: (messages: Message[]) => void
  /** The current value of the input */
  input: Writable<string>
  /** Form submission handler to automattically reset input and append a user message  */
  handleSubmit: (e: any, options?:ChatRequestOptions) => void
  metadata?: Object
  /** Whether the API request is in progress */
  isLoading: Writable<boolean>
}
const getStreamedResponse = async (
  api: string,
  chatRequest: ChatRequest,
  mutate: (messages: Message[]) => void,
  headers: Record<string, string> | Headers | undefined,
  body: any,
  previousMessages: Message[],
  abortControllerRef: AbortController | null,
  onFinish?: (message: Message) => void,
  onResponse?: (response: Response) => void | Promise<void>,
  sendExtraMessageFields?: boolean
) => {
  // Do an optimistic update to the chat state to show the updated messages
  // immediately.
  mutate(chatRequest.messages)

  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({
      messages: sendExtraMessageFields
        ? chatRequest.messages
        : chatRequest.messages.map(
            ({ role, content, name, function_call }) => ({
              role,
              content,
              ...(name !== undefined && { name }),
              ...(function_call !== undefined && {
                function_call: function_call
              })
            })
          ),
      ...body,
      ...chatRequest.options?.body,
      ...(chatRequest.functions !== undefined && {
        functions: chatRequest.functions
      }),
      ...(chatRequest.function_call !== undefined && {
        function_call: chatRequest.function_call
      })
    }),
    headers: {
      ...headers,
      ...chatRequest.options?.headers
    },
    ...(abortControllerRef !== null && {
      signal: abortControllerRef.signal
    })
  }).catch(err => {
    // Restore the previous messages if the request fails.
    mutate(previousMessages)
    throw err
  })

  if (onResponse) {
    try {
      await onResponse(res)
    } catch (err) {
      throw err
    }
  }

  if (!res.ok) {
    // Restore the previous messages if the request fails.
    mutate(previousMessages)
    throw new Error((await res.text()) || 'Failed to fetch the chat response.')
  }

  if (!res.body) {
    throw new Error('The response body is empty.')
  }

  let streamedResponse = ''
  const createdAt = new Date()
  const replyId = nanoid()
  const reader = res.body.getReader()
  const decode = createChunkDecoder()

  let responseMessage: Message = {
    id: replyId,
    createdAt,
    content: '',
    role: 'assistant'
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    // Update the chat state with the new message tokens.
    streamedResponse += decode(value)

    if (streamedResponse.startsWith('{"function_call":')) {
      // While the function call is streaming, it will be a string.
      responseMessage['function_call'] = streamedResponse
    } else {
      responseMessage['content'] = streamedResponse
    }

    mutate([...chatRequest.messages, { ...responseMessage }])

    // The request has been aborted, stop reading the stream.
    if (abortControllerRef === null) {
      reader.cancel()
      break
    }
  }

  if (streamedResponse.startsWith('{"function_call":')) {
    // Once the stream is complete, the function call is parsed into an object.
    const parsedFunctionCall: ChatCompletionRequestMessageFunctionCall =
      JSON.parse(streamedResponse).function_call

    responseMessage['function_call'] = parsedFunctionCall

    mutate([...chatRequest.messages, { ...responseMessage }])
  }

  if (onFinish) {
    onFinish(responseMessage)
  }

  return responseMessage
}

let uniqueId = 0

const store: Record<string, Message[] | undefined> = {}

export function useChat({
  api = '/api/chat',
  id,
  initialMessages = [],
  initialInput = '',
  sendExtraMessageFields,
  onFunctionCall,
  onResponse,
  onFinish,
  onError,
  headers,
  body
}: UseChatOptions = {}): UseChatHelpers {
  // Generate a unique ID for the chat if not provided.
  const chatId = id || `chat-${uniqueId++}`

  const key = `${api}|${chatId}`
  const { data, mutate: originalMutate } = useSWR<Message[]>(key, {
    fetcher: () => store[key] || initialMessages,
    initialData: initialMessages
  })
  // Force the `data` to be `initialMessages` if it's `undefined`.
  data.set(initialMessages)

  const mutate = (data: Message[]) => {
    store[key] = data
    return originalMutate(data)
  }

  // Because of the `initialData` option, the `data` will never be `undefined`.
  const messages = data as Writable<Message[]>

  const error = writable<undefined | Error>(undefined)
  const isLoading = writable(false)

  let abortController: AbortController | null = null
  async function triggerRequest(chatRequest: ChatRequest) {
    try {
      isLoading.set(true)
      abortController = new AbortController()

      while (true) {
        const streamedResponseMessage = await getStreamedResponse(
          api,
          chatRequest,
          mutate,
          headers, 
          body,
          get(messages),
          abortController,
          onFinish,
          onResponse,
          sendExtraMessageFields
        )
        
        if (
          streamedResponseMessage.function_call === undefined ||
          typeof streamedResponseMessage.function_call === 'string'
        ) {
          break
        }

        // Streamed response is a function call, invoke the function call handler if it exists.
        if (onFunctionCall) {
          const functionCall = streamedResponseMessage.function_call

          // User handles the function call in their own functionCallHandler.
          // The "arguments" of the function call object will still be a string which will have to be parsed in the function handler.
          // If the JSON is malformed due to model error the user will have to handle that themselves.

          const onFunctionCallResponse = await onFunctionCall(
            get(messages),
            functionCall
          )

          // If the user does not return anything, the loop will break.
          if (onFunctionCallResponse === undefined) break

          // Add function call response to the chat and automatically
          // send to the API in the next iteration of the loop.
          chatRequest = onFunctionCallResponse
        }
      }

      abortController = null

      return get(messages).at(-1)?.content?? ''
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === 'AbortError') {
        abortController = null
        return null
      }

      if (onError && err instanceof Error) {
        onError(err)
      }

      error.set(err as Error)
    } finally {
      isLoading.set(false)
    }
  }

  const append: UseChatHelpers['append'] = async (message, 
    chatOptions?:ChatRequestOptions) => {
    if (!message.id) {
      message.id = nanoid()
    }
    const{options, functions, function_call}=chatOptions??{};
    const chatRequest: ChatRequest = {
      messages: get(messages).concat(message as Message),
      options,
      ...(functions !== undefined && { functions }),
      ...(function_call !== undefined && { function_call })
    }
    return triggerRequest(chatRequest)
  }

  const reload: UseChatHelpers['reload'] = 
  async ({ options, functions, function_call }: ChatRequestOptions = {}) => {
    const messagesSnapshot = get(messages)
    if (messagesSnapshot.length === 0) return null

    // Remove last assistant message and retry last user message.
    const lastMessage = messagesSnapshot.at(-1)
    if (lastMessage?.role === 'assistant') {
      const chatRequest: ChatRequest = {
      messages: messagesSnapshot.slice(0, -1),
      options,
      ...(functions !== undefined && { functions }),
      ...(function_call !== undefined && { function_call })
      }

      return triggerRequest(chatRequest)
    }
  }

  const stop = () => {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
  }

  const setMessages = (messages: Message[]) => {
    mutate(messages)
  }

  const input = writable(initialInput)

  const handleSubmit = (
    e: any,
    options: ChatRequestOptions = {}
      ) => {
    e.preventDefault()
    const inputValue = get(input)
    if (!inputValue) return
    append(
      {
      content: inputValue,
      role: 'user',
      createdAt: new Date()
      },
      options)
    input.set('')
  }

  return {
    messages,
    append,
    error,
    reload,
    stop,
    setMessages,
    input,
    handleSubmit,
    isLoading
  }
}

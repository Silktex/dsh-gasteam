/** Deterministic runtime barrier: the worker is inside a real model request until cancellation. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export function progressAdapter() {
  let enter
  const entered = new Promise(resolve => { enter = resolve })
  class ProgressAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async * stream(options) {
      enter(options)
      if (!options.signal) throw new Error('Progress fixture requires cancellable worker requests')
      options.signal.throwIfAborted()
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    }
  }
  return { adapter: new ProgressAdapter(), entered }
}

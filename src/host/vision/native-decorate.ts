import { Remote } from '@deepseek-ai/dsh-typert-protocol'

type DecoratorContext = {
  kind: string
  name: string
  static: boolean
  private: boolean
  access: {
    has: (obj: object) => boolean
    get: (obj: object) => unknown
  }
}

function runInitializers(thisArg: object, initializers: Array<(this: object) => void>): void {
  for (const initializer of initializers) initializer.call(thisArg)
}

function esDecorate(
  ctor: { prototype: object },
  decorators: unknown[],
  contextIn: DecoratorContext,
  extraInitializers: Array<(this: object) => void>,
): void {
  const target = ctor.prototype
  const descriptor = Object.getOwnPropertyDescriptor(target, contextIn.name)
  if (descriptor === undefined) {
    throw new Error(`vision-bridge: missing method ${contextIn.name} for Remote decoration`)
  }
  let done = false
  for (let i = decorators.length - 1; i >= 0; i -= 1) {
    const decorator = decorators[i]
    if (typeof decorator !== 'function') throw new TypeError('Function expected')
    const context = {
      kind: contextIn.kind,
      name: contextIn.name,
      static: contextIn.static,
      private: contextIn.private,
      access: {
        has: contextIn.access.has,
        get: contextIn.access.get,
      },
      addInitializer: (fn: (this: object) => void): void => {
        if (done) throw new TypeError('Cannot add initializers after decoration has completed')
        extraInitializers.push(fn)
      },
    }
    const result: unknown = decorator(descriptor.value, context)
    if (result !== undefined) {
      if (typeof result !== 'function') throw new TypeError('Function expected')
      descriptor.value = result
    }
  }
  Object.defineProperty(target, contextIn.name, descriptor)
  done = true
}

/**
 * Apply Typert native `@Remote` method decorators without relying on oxc, which
 * cannot lower Stage-3 decorator syntax for Node 22.
 */
export function decorateRemoteMethods(
  ctor: { prototype: object },
  methods: Readonly<Record<string, string>>,
): (instance: object) => void {
  const extraInitializers: Array<(this: object) => void> = []
  for (const [name, remoteName] of Object.entries(methods)) {
    esDecorate(ctor, [Remote(remoteName)], {
      kind: 'method',
      name,
      static: false,
      private: false,
      access: {
        has: (obj) => name in obj,
        get: (obj) => Reflect.get(obj, name),
      },
    }, extraInitializers)
  }
  return (instance) => {
    runInitializers(instance, extraInitializers)
  }
}

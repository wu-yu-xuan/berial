import { App, Lifecycles } from './types'
import { importHtml } from './html-loader'
import { reactiveStore } from './store'
import { lifecycleCheck } from './util'

export enum Status {
  NOT_LOADED = 'NOT_LOADED',
  LOADING = 'LOADING',
  NOT_BOOTSTRAPPED = 'NOT_BOOTSTRAPPED',
  BOOTSTRAPPING = 'BOOTSTRAPPING',
  NOT_MOUNTED = 'NOT_MOUNTED',
  MOUNTING = 'MOUNTING',
  MOUNTED = 'MOUNTED',
  UPDATING = 'UPDATING',
  UPDATED = 'UPDATED',
  UNMOUNTING = 'UNMOUNTING'
}

let started = false
const apps: App[] = []
const globalStore = reactiveStore({})

export const getApps = () => apps
export const getGlobalStore = () => globalStore

export function register(
  name: string,
  entry: string,
  match: any,
  props: Record<string, unknown>
) {
  apps.push({
    name,
    entry,
    match,
    props,
    status: Status.NOT_LOADED
  } as App)
}

export function start() {
  started = true
  reroute()
}

function reroute() {
  const { loads, mounts, unmounts } = getAppChanges()
  if (started) {
    return perform()
  } else {
    return init()
  }
  async function init() {
    await Promise.all(loads.map(runLoad))
  }
  async function perform() {
    unmounts.map(runUnmount)
    loads.map(async (app) => {
      app = await runLoad(app)
      app = await runBootstrap(app)
      return runMount(app)
    })
    mounts.map(async (app) => {
      app = await runBootstrap(app)
      return runMount(app)
    })
  }
}

function getAppChanges() {
  const unmounts: App[] = []
  const loads: App[] = []
  const mounts: App[] = []
  apps.forEach((app) => {
    const isActive = app.match(window.location)
    switch (app.status) {
      case Status.NOT_LOADED:
      case Status.LOADING:
        isActive && loads.push(app)
        break
      case Status.NOT_BOOTSTRAPPED:
      case Status.BOOTSTRAPPING:
      case Status.NOT_MOUNTED:
        isActive && mounts.push(app)
        break
      case Status.MOUNTED:
        !isActive && unmounts.push(app)
    }
  })
  return { unmounts, loads, mounts }
}

function compose(fns: ((props: any) => Promise<any>)[]) {
  fns = Array.isArray(fns) ? fns : [fns]
  return (props: any) =>
    fns.reduce((p, fn) => p.then(() => fn(props)), Promise.resolve())
}

async function runLoad(app: App) {
  if (app.loaded) {
    return app.loaded
  }
  app.loaded = Promise.resolve().then(async () => {
    app.status = Status.LOADING
    const host = await loadShadow(app)
    let lifecycle: Lifecycles
    if (typeof app.entry === 'string') {
      lifecycle = await importHtml(app, host)
      lifecycleCheck(lifecycle)
    } else {
      const exportedLifecycles = await app.entry(app.props)
      lifecycleCheck(exportedLifecycles)

      const { bootstrap, mount, unmount, update } = exportedLifecycles
      lifecycle = {} as Lifecycles
      lifecycle.bootstrap = bootstrap ? [bootstrap] : []
      lifecycle.mount = mount ? [mount] : []
      lifecycle.unmount = unmount ? [unmount] : []
      lifecycle.update = update ? [update] : []
    }
    app.status = Status.NOT_BOOTSTRAPPED
    app.bootstrap = compose(lifecycle.bootstrap)
    app.mount = compose(lifecycle.mount)
    app.unmount = compose(lifecycle.unmount)
    app.update = compose(lifecycle.update)
    app.host = host as Element
    delete app.loaded
    return app
  })
  return app.loaded
}

async function loadShadow(app: App) {
  return new Promise<Element>((resolve, reject) => {
    try {
      class Berial extends HTMLElement {
        static get componentName() {
          return app.name
        }
        connectedCallback() {
          this.attachShadow({ mode: 'open' })
          resolve(this)
        }
        constructor() {
          super()
        }
      }
      const hasDef = window.customElements.get(app.name)
      if (!hasDef) {
        customElements.define(app.name, Berial)
      }
      return hasDef
    } catch (e) {
      reject(e)
    }
  })
}

async function runUnmount(app: App) {
  if (app.status != Status.MOUNTED) {
    return app
  }
  app.status = Status.UNMOUNTING
  await app.unmount(app.props)
  app.status = Status.NOT_MOUNTED
  return app
}

async function runBootstrap(app: App) {
  if (app.status !== Status.NOT_BOOTSTRAPPED) {
    return app
  }
  app.status = Status.BOOTSTRAPPING
  await app.bootstrap(app.props)
  app.status = Status.NOT_MOUNTED
  return app
}

async function runMount(app: App) {
  if (app.status !== Status.NOT_MOUNTED) {
    return app
  }
  app.status = Status.MOUNTING
  await app.mount(app.props)
  app.status = Status.MOUNTED
  return app
}

const routingEventsListeningTo = ['hashchange', 'popstate']

function urlReroute() {
  reroute()
}
const capturedEventListeners = {
  hashchange: [],
  popstate: []
} as any

window.addEventListener('hashchange', urlReroute)
window.addEventListener('popstate', urlReroute)
const originalAddEventListener = window.addEventListener
const originalRemoveEventListener = window.removeEventListener
window.addEventListener = function(name: any, fn: any, ...args: any) {
  if (
    routingEventsListeningTo.indexOf(name) >= 0 &&
    !capturedEventListeners[name].some((l: any) => l == fn)
  ) {
    capturedEventListeners[name].push(fn)
    return
  }
  // @ts-ignore
  return originalAddEventListener.apply(this, args)
}
window.removeEventListener = function(name: any, fn: any, ...args: any) {
  if (routingEventsListeningTo.indexOf(name) >= 0) {
    capturedEventListeners[name] = capturedEventListeners[name].filter(
      (l: any) => l !== fn
    )
    return
  }
  //@ts-ignore
  return originalRemoveEventListener.apply(this, args)
}

function patchedUpdateState(updateState: any, ...args: any) {
  return function() {
    const urlBefore = window.location.href
    // @ts-ignore
    updateState.apply(this, args)
    const urlAfter = window.location.href

    if (urlBefore !== urlAfter) {
      // @ts-ignore
      urlReroute(new PopStateEvent('popstate'))
    }
  }
}

window.history.pushState = patchedUpdateState(window.history.pushState)
window.history.replaceState = patchedUpdateState(window.history.replaceState)

import {
  ControllerMessage,
  Manifest,
  WorkerLike,
  WorkerMessage,
} from "./types";

interface SysCallMapping {
  [key: string]: (...args: any) => Promise<any> | any;
}

export class Sandbox {
  protected worker: WorkerLike;
  protected reqId = 0;
  protected outstandingInits = new Map<string, () => void>();
  protected outstandingInvocations = new Map<
    number,
    { resolve: (result: any) => void; reject: (e: any) => void }
  >();
  protected loadedFunctions = new Set<string>();
  protected system: System<any>;

  constructor(system: System<any>, worker: WorkerLike) {
    worker.onMessage = this.onMessage.bind(this);
    this.worker = worker;
    this.system = system;
  }

  isLoaded(name: string) {
    return this.loadedFunctions.has(name);
  }

  async load(name: string, code: string): Promise<void> {
    this.worker.postMessage({
      type: "load",
      name: name,
      code: code,
    } as WorkerMessage);
    return new Promise((resolve) => {
      this.loadedFunctions.add(name);
      this.outstandingInits.set(name, resolve);
    });
  }

  async onMessage(data: ControllerMessage) {
    switch (data.type) {
      case "inited":
        let initCb = this.outstandingInits.get(data.name!);
        initCb && initCb();
        this.outstandingInits.delete(data.name!);
        break;
      case "syscall":
        try {
          let result = await this.system.syscall(data.name!, data.args!);

          this.worker.postMessage({
            type: "syscall-response",
            id: data.id,
            result: result,
          } as WorkerMessage);
        } catch (e: any) {
          this.worker.postMessage({
            type: "syscall-response",
            id: data.id,
            error: e.message,
          } as WorkerMessage);
        }
        break;
      case "result":
        let resultCbs = this.outstandingInvocations.get(data.id!);
        this.outstandingInvocations.delete(data.id!);
        if (data.error) {
          resultCbs && resultCbs.reject(new Error(data.error));
        } else {
          resultCbs && resultCbs.resolve(data.result);
        }
        break;
      default:
        console.error("Unknown message type", data);
    }
  }

  async invoke(name: string, args: any[]): Promise<any> {
    this.reqId++;
    this.worker.postMessage({
      type: "invoke",
      id: this.reqId,
      name,
      args,
    });
    return new Promise((resolve, reject) => {
      this.outstandingInvocations.set(this.reqId, { resolve, reject });
    });
  }

  stop() {
    this.worker.terminate();
  }
}

export class Plug<HookT> {
  system: System<HookT>;
  sandbox: Sandbox;
  public manifest?: Manifest<HookT>;

  constructor(system: System<HookT>, name: string, sandbox: Sandbox) {
    this.system = system;
    this.sandbox = sandbox;
  }

  async load(manifest: Manifest<HookT>) {
    this.manifest = manifest;
    await this.dispatchEvent("load");
  }

  async invoke(name: string, args: Array<any>): Promise<any> {
    if (!this.sandbox.isLoaded(name)) {
      const funDef = this.manifest!.functions[name];
      if (!funDef) {
        throw new Error(`Function ${name} not found in manifest`);
      }
      await this.sandbox.load(name, this.manifest!.functions[name].code!);
    }
    return await this.sandbox.invoke(name, args);
  }

  async dispatchEvent(name: string, data?: any): Promise<any[]> {
    let functionsToSpawn = this.manifest!.hooks.events[name];
    if (functionsToSpawn) {
      return await Promise.all(
        functionsToSpawn.map(
          async (functionToSpawn: string) =>
            await this.invoke(functionToSpawn, [data])
        )
      );
    } else {
      return [];
    }
  }

  async stop() {
    this.sandbox.stop();
  }
}

export class System<HookT> {
  protected plugs = new Map<string, Plug<HookT>>();
  registeredSyscalls: SysCallMapping = {};

  registerSyscalls(...registrationObjects: SysCallMapping[]) {
    for (const registrationObject of registrationObjects) {
      for (let p in registrationObject) {
        this.registeredSyscalls[p] = registrationObject[p];
      }
    }
  }

  async syscall(name: string, args: Array<any>): Promise<any> {
    const callback = this.registeredSyscalls[name];
    if (!name) {
      throw Error(`Unregistered syscall ${name}`);
    }
    if (!callback) {
      throw Error(`Registered but not implemented syscall ${name}`);
    }
    return Promise.resolve(callback(...args));
  }

  async load(
    name: string,
    manifest: Manifest<HookT>,
    sandbox: Sandbox
  ): Promise<Plug<HookT>> {
    const plug = new Plug(this, name, sandbox);
    await plug.load(manifest);
    this.plugs.set(name, plug);
    return plug;
  }

  async dispatchEvent(name: string, data?: any): Promise<any[]> {
    let promises = [];
    for (let plug of this.plugs.values()) {
      promises.push(plug.dispatchEvent(name, data));
    }
    return await Promise.all(promises);
  }

  async stop(): Promise<void[]> {
    return Promise.all(
      Array.from(this.plugs.values()).map((plug) => plug.stop())
    );
  }
}

/* eslint-disable @typescript-eslint/no-this-alias */
/* eslint-disable @typescript-eslint/ban-types */
import { context, Context, diag, propagation, ROOT_CONTEXT, Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { RPCMetadata, RPCType, setRPCMetadata } from "@opentelemetry/core";
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  isWrapped,
  safeExecuteInTheMiddle,
} from "@opentelemetry/instrumentation";
import { getIncomingRequestAttributes } from "@opentelemetry/instrumentation-http";
import { SemanticAttributes } from "@opentelemetry/semantic-conventions";
import type * as http from "http";
import type * as https from "http";
import { IncomingMessage } from "http";
import isPromise from "is-promise";
import { Duplex } from "stream";
import WS, { ErrorEvent, Server, WebSocket } from "ws";
import { WSInstrumentationConfig } from "./types";

const endSpan = (traced: () => any | Promise<any>, span: Span) => {
  try {
    const result = traced();
    if (isPromise(result)) {
      return Promise.resolve(result)
        .catch((err) => {
          if (err) {
            if (typeof err === "string") {
              span.setStatus({ code: SpanStatusCode.ERROR, message: err });
            } else {
              span.recordException(err);
              span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
            }
          }
          throw err;
        })
        .finally(() => span.end());
    } else {
      span.end();
      return result;
    }
  } catch (error: any) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
    span.end();
    throw error;
  }
};

interface ExtendedWebsocket extends WebSocket {
  _parentContext: Context;
  _openSpan: Span | undefined;
}

/** Instrumentation for the `ws` library WebSocket class */
export class WSInstrumentation extends InstrumentationBase<WS> {
  protected override _config: WSInstrumentationConfig = {};
  protected _requestSpans = new WeakMap<IncomingMessage, Span>();

  constructor(config: WSInstrumentationConfig = {}) {
    super("opentelemetry-instrumentation-ws", "0.4.2", config);
  }

  protected init() {
    const self = this;

    return [
      new InstrumentationNodeModuleDefinition<WS>(
        "ws",
        [">=7"],
        (moduleExports, moduleVersion) => {
          if (moduleExports === undefined || moduleExports === null) {
            return moduleExports;
          }

          if (isWrapped(moduleExports)) {
            throw new Error("Can't double wrap the ws constructor");
          }

          diag.debug(`ws instrumentation: applying patch to ws@${moduleVersion}`);

          const WebSocket = this._patchConstructor(moduleExports as any);

          if (self._config.sendSpans) {
            if (isWrapped(WebSocket.prototype.send)) {
              this._unwrap(WebSocket.prototype, "send");
            }
            this._wrap(WebSocket.prototype, "send", this._patchSend);
          }

          if (isWrapped(WebSocket.prototype.close)) {
            this._unwrap(WebSocket.prototype, "close");
          }
          this._wrap(WebSocket.prototype, "close", this._patchClose);

          if (isWrapped(WebSocket.Server.prototype.handleUpgrade)) {
            this._unwrap(WebSocket.Server.prototype, "handleUpgrade");
          }
          this._wrap(WebSocket.Server.prototype, "handleUpgrade", this._patchServerHandleUpgrade);

          return WebSocket as any;
        },
        (moduleExports) => {
          return (moduleExports as any).__original;
        }
      ),
      new InstrumentationNodeModuleDefinition<typeof http>(
        "http",
        ["*"],
        (moduleExports) => {
          if (moduleExports === undefined || moduleExports === null) {
            return moduleExports;
          }

          diag.debug(`ws instrumentation: applying patch to http`);

          this._wrap(moduleExports.Server.prototype, "emit", this._patchIncomingRequestEmit);
          return moduleExports;
        },
        (moduleExports) => {
          if (moduleExports === undefined) return;
          this._diag.debug(`Removing patch for http`);
          this._unwrap(moduleExports.Server.prototype, "emit");
        }
      ),
      new InstrumentationNodeModuleDefinition<typeof https>(
        "https",
        ["*"],
        (moduleExports) => {
          if (moduleExports === undefined || moduleExports === null) {
            return moduleExports;
          }

          diag.debug(`ws instrumentation: applying patch to https`);

          this._wrap(moduleExports.Server.prototype, "emit", this._patchIncomingRequestEmit);
          return moduleExports;
        },
        (moduleExports) => {
          if (moduleExports === undefined) return;
          this._diag.debug(`Removing patch for https`);
          this._unwrap(moduleExports.Server.prototype, "emit");
        }
      ),
    ];
  }

  private _patchConstructor(OriginalWebSocket: typeof WebSocket) {
    const self = this;

    const klass = class WebSocket extends OriginalWebSocket implements ExtendedWebsocket {
      _parentContext: Context;
      _openSpan: Span | undefined;

      constructor(address: string, protocols: any, options: any) {
        let connectingSpan: Span | null = null;

        if (!options) {
          options = {};
        }

        if (address != null) {
          connectingSpan = self.tracer.startSpan(`WS connect`, {
            kind: SpanKind.CLIENT,
            attributes: {
              [SemanticAttributes.MESSAGING_SYSTEM]: "ws",
              [SemanticAttributes.MESSAGING_DESTINATION_KIND]: "websocket",
              [SemanticAttributes.MESSAGING_OPERATION]: "connect",
            },
          });

          if (!options.headers) {
            options.headers = {};
          }

          const requestContext = trace.setSpan(context.active(), connectingSpan);
          propagation.inject(requestContext, options.headers);
        }

        super(address, protocols, options);
        this._parentContext = context.active();

        if (connectingSpan) {
          connectingSpan.setAttributes({
            [SemanticAttributes.MESSAGING_DESTINATION]: this.url,
            [SemanticAttributes.MESSAGING_PROTOCOL]: this.protocol,
          });

          const connectionErrorListener = (error: ErrorEvent) => {
            connectingSpan!.recordException(error);
            connectingSpan!.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
            connectingSpan!.end();
          };

          this.once("error", connectionErrorListener);

          this.once("open", () => {
            connectingSpan!.end();
            this.removeEventListener("error", connectionErrorListener);
          });
        }

        this.once("open", () => {
          this._openSpan = self.tracer.startSpan(`WS open`, {
            kind: connectingSpan ? SpanKind.CLIENT : SpanKind.SERVER,
            attributes: {
              [SemanticAttributes.MESSAGING_SYSTEM]: "ws",
              [SemanticAttributes.MESSAGING_DESTINATION_KIND]: "websocket",
            },
          });
          // we don't really have anything to do with the new context returned here, just let it float
          trace.setSpan(context.active(), this._openSpan);
        });

        this.once("error", (error: ErrorEvent) => {
          this._openSpan?.recordException(error);
          this._openSpan?.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
        });

        this.once("close", (close: CloseEvent) => {
          this._openSpan?.setAttributes({
            "ws.close.code": close.code,
            "ws.close.reason": close.reason,
            "ws.close.wasClean": close.wasClean,
          });
          this._openSpan?.end();
        });

        if (self._config.messageEvents) {
          this.on("message", (_message: MessageEvent) => {
            this._openSpan?.addEvent("ws.incoming-message", {
              [SemanticAttributes.MESSAGING_SYSTEM]: "ws",
            });
          });
        }
      }
    };

    (klass as any).__original == OriginalWebSocket;
    (klass as any).__wrapped = true;
    return klass;
  }

  private _patchSend = (original: (this: ExtendedWebsocket, data: string, options?: any, callback?: any) => any) => {
    const self = this;

    return function (this: ExtendedWebsocket, data: string, options?: any, callback?: any) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }

      const span = self.tracer.startSpan(`WS send`, {
        kind: SpanKind.CLIENT,
        attributes: {
          [SemanticAttributes.MESSAGING_DESTINATION]: this.url,
        },
      });

      if (self._config.sendHook) {
        safeExecuteInTheMiddle(
          () =>
            self._config.sendHook!(span, {
              payload: {
                data,
                options,
              },
            }),
          (e) => {
            if (e) {
              diag.error("ws instrumentation: sendHook failed", e);
            }
          },
          true
        );
      }

      return context.with(trace.setSpan(context.active(), span), () => {
        original.call(this, data, options, (err: Error | null, ...results: any[]) => {
          if (err) {
            if (typeof err === "string") {
              span.setStatus({ code: SpanStatusCode.ERROR, message: err });
            } else {
              span.recordException(err);
              span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
            }
          }
          span.end();
          callback?.(err, ...results);
        });
      });
    };
  };

  private _patchClose = (original: (this: ExtendedWebsocket, ...args: any[]) => any) => {
    const self = this;

    return function (this: ExtendedWebsocket, ...args: any[]) {
      const span = self.tracer.startSpan(`WS close`, {
        kind: SpanKind.CLIENT,
        attributes: {
          [SemanticAttributes.MESSAGING_DESTINATION]: this.url,
        },
      });

      if (self._config.closeHook) {
        safeExecuteInTheMiddle(
          () => self._config.closeHook!(span, { payload: args }),
          (e) => {
            if (e) {
              diag.error("ws instrumentation: closeHook failed", e);
            }
          },
          true
        );
      }

      return context.with(trace.setSpan(context.active(), span), () => endSpan(() => original.apply(this, args as any), span));
    };
  };

  private _patchIncomingRequestEmit = (original: (this: unknown, event: string, ...args: any[]) => boolean) => {
    const self = this;

    return function incomingRequest(this: unknown, event: string, ...args: any[]): boolean {
      // Only traces upgrade events
      if (event !== "upgrade") {
        return original.call(this, event, ...args);
      }
      const request = args[0] as IncomingMessage;
      const emitter = this;

      const ctx = propagation.extract(ROOT_CONTEXT, request.headers);
      const span = self.tracer.startSpan(
        `HTTP GET WS`,
        {
          kind: SpanKind.SERVER,
          attributes: getIncomingRequestAttributes(request, {
            component: "WS",
            hookAttributes: {
              [SemanticAttributes.NET_HOST_IP]: request.socket.localAddress,
              [SemanticAttributes.NET_HOST_PORT]: request.socket.localPort,
              [SemanticAttributes.NET_PEER_IP]: request.socket.remoteAddress,
              [SemanticAttributes.NET_PEER_PORT]: request.socket.remotePort,
            },
          }),
        },
        ctx
      );

      const rpcMetadata: RPCMetadata = {
        type: RPCType.HTTP,
        span,
      };

      self._requestSpans.set(request, span);
      return context.with(setRPCMetadata(trace.setSpan(ctx, span), rpcMetadata), () => {
        try {
          return original.call(emitter, event, ...args);
        } catch (error: any) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
          span.end();
          self._requestSpans.delete(request);
          throw error;
        }
      });
    };
  };

  private _patchServerHandleUpgrade = (
    original: (
      this: Server,
      request: IncomingMessage,
      socket: Duplex,
      upgradeHead: Buffer,
      callback: (client: WebSocket, request: IncomingMessage) => void
    ) => any
  ) => {
    const self = this;

    return function (
      this: Server,
      request: IncomingMessage,
      socket: Duplex,
      upgradeHead: Buffer,
      callback: (client: WebSocket, request: IncomingMessage) => void
    ) {
      const parentSpan = self._requestSpans.get(request);
      const span = self.tracer.startSpan(`WS upgrade`, {
        kind: SpanKind.SERVER,
        attributes: getIncomingRequestAttributes(request, {
          component: "WS",
          hookAttributes: {
            [SemanticAttributes.NET_HOST_IP]: request.socket.localAddress,
            [SemanticAttributes.NET_HOST_PORT]: request.socket.localPort,
            [SemanticAttributes.NET_PEER_IP]: request.socket.remoteAddress,
            [SemanticAttributes.NET_PEER_PORT]: request.socket.remotePort,
          },
        }),
      });

      if (self._config.handleUpgradeHook) {
        safeExecuteInTheMiddle(
          () => self._config.handleUpgradeHook!(span, { payload: { request, socket, upgradeHead } }),
          (e) => {
            if (e) {
              diag.error("ws instrumentation: handleUpgradeHook failed", e);
            }
          },
          true
        );
      }

      return context.with(trace.setSpan(context.active(), span), () => {
        return endSpan(
          () =>
            original.call(this, request, socket, upgradeHead, function (this: any, websocket: WebSocket, request: IncomingMessage) {
              parentSpan?.setAttributes({
                [SemanticAttributes.HTTP_STATUS_CODE]: 101,
              });
              parentSpan?.end();
              self._requestSpans.delete(request);

              return callback.call(this, websocket, request);
            }),
          span
        );
      });
    };
  };
}

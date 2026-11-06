/// <reference types="node" />
export declare const environment: {
  raycastVersion: string;
  extensionName: string;
};
export declare function showToast(title: string): Promise<void>;
export declare function showHUD(title: string): Promise<void>;
declare type InternalThing = { id: string };
export declare function getPreferenceValues<T>(): T;
export declare function open(target: string): Promise<void>;
export declare function showFailureToast(error: unknown): Promise<void>;

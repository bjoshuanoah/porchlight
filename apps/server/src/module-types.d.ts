declare module "@porchlight/identity" {
  export function createIdentityRouter(): import("express").Router;
}

declare module "@porchlight/social" {
  export function createSocialRouter(): import("express").Router;
}
import { randomUUID } from "node:crypto";

/** Session-scoped opaque secret handles. Plaintext never leaves this process. */
export class BrowserSecretVault {
  private readonly secrets = new Map<string, { value: string; expiresAt: number }>();

  issue(value: string, ttlMs = 60_000): string {
    const id = `secret://${randomUUID()}`;
    this.secrets.set(id, { value, expiresAt: Date.now() + Math.max(1_000, ttlMs) });
    return id;
  }

  resolve(secretRef: string): string {
    const secret = this.secrets.get(secretRef);
    if (!secret || secret.expiresAt <= Date.now()) {
      this.secrets.delete(secretRef);
      throw new Error("Secret is unavailable.");
    }
    return secret.value;
  }

  consume(secretRef: string): string {
    const value = this.resolve(secretRef);
    this.secrets.delete(secretRef);
    return value;
  }

  clear(): void { this.secrets.clear(); }
}

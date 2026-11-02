/**
 * Registration validation shared by the register form (client) and `POST /api/register`
 * (server), so both enforce exactly the same rules as the backend
 * (`name` 1–80, valid `email`, `password` 8–128).
 */
import { z } from "zod";

export const NAME_MAX = 80;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export const registerSchema = z.object({
  name: z
    .string({ error: "Name is required" })
    .trim()
    .min(1, { error: "Please enter your name" })
    .max(NAME_MAX, { error: `Name must be at most ${NAME_MAX} characters` }),
  email: z
    .string({ error: "Email is required" })
    .trim()
    .toLowerCase()
    .min(1, { error: "Please enter your email" })
    .pipe(z.email({ error: "Please enter a valid email address" }).max(254)),
  password: z
    .string({ error: "Password is required" })
    .min(PASSWORD_MIN, { error: `Password must be at least ${PASSWORD_MIN} characters` })
    .max(PASSWORD_MAX, { error: `Password must be at most ${PASSWORD_MAX} characters` }),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export type RegisterField = keyof RegisterInput;

/** Flattens zod issues into `{ field: firstMessage }` for inline form errors. */
export function fieldErrors(error: z.ZodError): Partial<Record<RegisterField, string>> {
  const out: Partial<Record<RegisterField, string>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (field === "name" || field === "email" || field === "password") {
      out[field] ??= issue.message;
    }
  }
  return out;
}

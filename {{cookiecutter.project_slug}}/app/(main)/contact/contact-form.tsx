"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { contactSchema, type ContactInput } from "@/lib/validations";

export function ContactForm() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    type: "feedback" as ContactInput["type"],
    subject: "",
    message: "",
  });

  const update = (key: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);

    const parsed = contactSchema.safeParse(form);
    if (!parsed.success) {
      setStatus({ type: "error", message: parsed.error.issues[0].message });
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to send");
      }

      setForm({
        name: "",
        email: "",
        type: "feedback",
        subject: "",
        message: "",
      });
      setStatus({ type: "success", message: "Message sent! We'll get back to you soon." });
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to send message",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="grid gap-5 md:grid-cols-2">
        <label className="flex flex-col">
          <span className="mb-2 block text-sm font-semibold text-base-content/80">Name</span>
          <input
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            type="text"
            autoComplete="name"
            required
            className="input w-full"
          />
        </label>
        <label className="flex flex-col">
          <span className="mb-2 block text-sm font-semibold text-base-content/80">Email</span>
          <input
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
            type="email"
            autoComplete="email"
            required
            className="input w-full"
          />
        </label>
      </div>

      <label className="flex flex-col">
        <span className="mb-2 block text-sm font-semibold text-base-content/80">Type</span>
        <select
          value={form.type}
          onChange={(e) => update("type", e.target.value)}
          className="select w-full"
        >
          <option value="feedback">Feedback</option>
          <option value="support">Support issue</option>
        </select>
      </label>

      <label className="flex flex-col">
        <span className="mb-2 block text-sm font-semibold text-base-content/80">Subject</span>
        <input
          value={form.subject}
          onChange={(e) => update("subject", e.target.value)}
          type="text"
          required
          className="input w-full"
        />
      </label>

      <label className="flex flex-col">
        <span className="mb-2 block text-sm font-semibold text-base-content/80">Message</span>
        <textarea
          value={form.message}
          onChange={(e) => update("message", e.target.value)}
          required
          rows={6}
          className="textarea min-h-40 w-full"
          placeholder="Tell us what's on your mind..."
        />
      </label>

      {status && (
        <div className={`alert ${status.type === "success" ? "alert-success" : "alert-error"} text-sm`}>
          <span>{status.message}</span>
        </div>
      )}

      <button type="submit" className="btn btn-primary btn-wide min-h-11" disabled={isSubmitting}>
        {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : "Send message"}
      </button>
    </form>
  );
}

"use client";

import type { SpecOutput } from "@/lib/schemas";

interface SpecCardProps {
  spec: SpecOutput;
  onApprove: () => void;
  onReject: () => void;
  disabled?: boolean;
}

const SECTIONS: {
  /** 仅三段式数组字段（SpecOutput 扩展 architecture 对象字段后需显式收窄） */
  key: "requirements" | "constraints" | "userStories";
  title: string;
  className: string;
}[] = [
  {
    key: "requirements",
    title: "Requirements",
    className: "bg-blue-50 dark:bg-blue-950/40",
  },
  {
    key: "constraints",
    title: "Constraints",
    className: "bg-amber-50 dark:bg-amber-950/40",
  },
  {
    key: "userStories",
    title: "User Stories",
    className: "bg-green-50 dark:bg-green-950/40",
  },
];

/** approve 阶段的三段式规格确认卡片 */
export default function SpecCard({
  spec,
  onApprove,
  onReject,
  disabled,
}: SpecCardProps) {
  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
      {SECTIONS.map(({ key, title, className }) => (
        <section key={key} className={`px-3 py-2 ${className}`}>
          <h4 className="text-xs font-semibold uppercase tracking-wide opacity-70">
            {title}
          </h4>
          <ul className="mt-1 list-disc pl-4 text-sm space-y-0.5">
            {(spec[key] ?? []).map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
      <div className="flex gap-2 px-3 py-2 bg-white dark:bg-neutral-900">
        <button
          type="button"
          onClick={onApprove}
          disabled={disabled}
          className="flex-1 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          确认
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={disabled}
          className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          修改
        </button>
      </div>
    </div>
  );
}

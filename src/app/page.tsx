"use client";

import ChatPanel from "./components/ChatPanel";
import PipelineTimeline from "./components/PipelineTimeline";
import PreviewFrame from "./components/PreviewFrame";
import { usePipeline } from "./hooks/usePipeline";

export default function Home() {
  const {
    stages,
    messages,
    spec,
    awaitingApproval,
    preview,
    running,
    sendMessage,
    approve,
    reject,
  } = usePipeline();

  return (
    <main className="flex flex-1 flex-col lg:h-screen lg:flex-row lg:overflow-hidden">
      <section className="flex min-h-[70vh] flex-col lg:min-h-0 lg:w-[55%] lg:border-r lg:border-neutral-200 lg:dark:border-neutral-700">
        <div className="shrink-0 overflow-y-auto lg:max-h-[45%]">
          <PipelineTimeline
            stages={stages}
            spec={spec}
            awaitingApproval={awaitingApproval}
            onApprove={approve}
            onReject={reject}
          />
        </div>
        <ChatPanel
          messages={messages}
          onSend={sendMessage}
          disabled={running}
        />
      </section>
      <section className="h-[60vh] lg:h-auto lg:min-h-0 lg:w-[45%]">
        <PreviewFrame preview={preview} />
      </section>
    </main>
  );
}

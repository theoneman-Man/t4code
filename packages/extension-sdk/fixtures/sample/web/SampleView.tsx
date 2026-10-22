import { useEffect, useState } from "react";
import { Button, Input, useExtFetch, useExtEvents, type ExtView } from "@t3tools/extension-sdk";
import "./sample.css";

const SampleView: ExtView = ({ active }) => {
  const fetch = useExtFetch();
  const [message, setMessage] = useState("Loading message");
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState("");
  const load = () => {
    const abort = new AbortController();
    void fetch("/hello", { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Sample request failed.");
        const data = (await response.json()) as { message: string };
        if (!abort.signal.aborted) setMessage(data.message);
      })
      .catch(() => {
        if (!abort.signal.aborted) setMessage("Message unavailable");
      });
    return () => abort.abort();
  };
  useEffect(load, [fetch]);
  useExtEvents("tick", (event) => {
    if (event.topic === "reset") {
      load();
      return;
    }
    const data = event.data as { n?: unknown };
    if (typeof data.n === "number") setTick(data.n);
  });
  return (
    <section className="sample-view" aria-label="Sample view" data-active={active}>
      <p>{message}</p>
      <p>Last tick: {tick}</p>
      <Input
        aria-label="Sample draft"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <Button variant="outline" onClick={load}>
        Reload message
      </Button>
    </section>
  );
};
export default SampleView;

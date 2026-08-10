import React, { useEffect, useRef, useState } from "react";
import { LockKeyhole, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { createReceiptReviewCommand, loadReceiptPolicy, updateReceiptPolicy } from "../../services/receiptReview";
import "./receipt-policy.css";

const defaults = {
  min_match_score: 80,
  require_reason_below: 90,
  allow_reject: true,
  allow_correction: true,
  require_finalization: true,
  require_separate_finalizer: true,
  version: 0,
};

export function ReceiptPolicyPanel({ client, isOwner, flash = () => {} }) {
  const [policy, setPolicy] = useState(defaults);
  const [state, setState] = useState("loading");
  const [reason, setReason] = useState("");
  const command = useRef(null);

  const load = async () => {
    setState("loading");
    try { setPolicy(await loadReceiptPolicy(client)); setState("ready"); }
    catch (error) { console.error("receipt policy", error); setState("error"); }
  };
  useEffect(() => { load(); }, [client]);

  const save = async () => {
    const min = Number(policy.min_match_score);
    const below = Number(policy.require_reason_below);
    if (!Number.isInteger(min) || !Number.isInteger(below) || min < 0 || below < min || below > 100) {
      return flash("Receipt policy threshold ـەکان نادروستن");
    }
    if (reason.trim().length < 12) return flash("هۆکاری گۆڕینی policy لانیکەم ١٢ پیت بێت");
    command.current ||= createReceiptReviewCommand("policy", "policy");
    setState("saving");
    try {
      await updateReceiptPolicy(client, { policy: {
        min_match_score: min,
        require_reason_below: below,
        allow_reject: !!policy.allow_reject,
        allow_correction: !!policy.allow_correction,
        require_finalization: !!policy.require_finalization,
        require_separate_finalizer: !!policy.require_separate_finalizer,
      }, updateReason: reason, commandKey: command.current });
      command.current = null;
      setReason("");
      await load();
      flash("Receipt policy پاشەکەوت و audit کرا ✓");
    } catch (error) {
      console.error("receipt policy update", error);
      setState("ready");
      flash(error?.message || "Receipt policy پاشەکەوت نەکرا");
    }
  };

  return <section className="receipt-policy-panel" aria-labelledby="receipt-policy-title">
    <header>
      <span className="receipt-policy-icon"><ShieldCheck aria-hidden="true" /></span>
      <div><h2 id="receipt-policy-title">Receipt Review Policy</h2><p>score threshold، هۆکاری بڕیار و maker/checker finalization</p></div>
      <span className="receipt-policy-version">v{policy.version || "—"}</span>
    </header>

    {state === "error" ? <div className="receipt-policy-error" role="alert">Policy بار نەبوو <button type="button" onClick={load}><RefreshCw aria-hidden="true" /> دووبارە</button></div> : <>
      <div className="receipt-policy-grid">
        <label>کەمترین نمرەی accept<input type="number" min="0" max="100" value={policy.min_match_score} disabled={!isOwner || state !== "ready"} onChange={(event) => setPolicy({ ...policy, min_match_score: event.target.value })} /></label>
        <label>هۆکار پێویستە لە ژێر<input type="number" min="0" max="100" value={policy.require_reason_below} disabled={!isOwner || state !== "ready"} onChange={(event) => setPolicy({ ...policy, require_reason_below: event.target.value })} /></label>
      </div>
      <div className="receipt-policy-checks">
        {[
          ["allow_reject", "ڕەتکردنەوە ڕێپێدراوە"],
          ["allow_correction", "گەڕاندنەوە بۆ correction ڕێپێدراوە"],
          ["require_finalization", "Finalization پێویستە"],
          ["require_separate_finalizer", "Maker و finalizer جیاوازن"],
        ].map(([key, label]) => <label key={key}><input type="checkbox" checked={!!policy[key]} disabled={!isOwner || state !== "ready"} onChange={(event) => setPolicy({ ...policy, [key]: event.target.checked })} /><span>{label}</span></label>)}
      </div>
      {isOwner ? <div className="receipt-policy-save"><label>هۆکاری گۆڕین<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="لانیکەم ١٢ پیت؛ لە audit ـدا دەمێنێتەوە" /></label><button type="button" onClick={save} disabled={state !== "ready" || reason.trim().length < 12}><Save aria-hidden="true" /> پاشەکەوتکردن</button></div> : <div className="receipt-policy-locked"><LockKeyhole aria-hidden="true" /> تەنها System Owner دەتوانێت policy بگۆڕێت</div>}
    </>}
  </section>;
}

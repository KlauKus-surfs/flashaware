import { useEffect, useState } from 'react';
import { sendRecipientOtp, verifyRecipientOtp } from '../api';
import { useToast } from '../components/ToastProvider';

// Self-contained OTP state machine for verifying a recipient's phone before
// SMS/WhatsApp dispatch is unlocked. Pulled out of LocationEditor.tsx so the
// dialog can be unit-tested and the editor itself shrinks by ~110 lines.
//
// Lifecycle:
//   start(recipient)  → POST /send-otp (handles rate-limit), open dialog
//   resend()          → POST /send-otp again, reset attempts and expiry
//   verify(code)      → POST /verify-otp, on success close + onVerified()
//   close()           → drop state, close dialog
//
// The countdown shown in the UI is driven by `state.expiresAt` / `state.retryAt`
// (epoch ms). Callers should re-render every second while a dialog is open so
// the timer ticks; useTickWhileOpen() below gives them a one-liner.

export interface PhoneRecipient {
  id: number;
  phone: string | null;
}

export interface PhoneVerificationState {
  recipient: PhoneRecipient | null;
  code: string;
  sending: boolean;
  verifying: boolean;
  expiresAt: number | null;        // epoch ms — code valid until
  retryAt: number | null;          // epoch ms — rate-limit ends
  attemptsRemaining: number | null;
  errorMessage: string | null;
}

const initialState: PhoneVerificationState = {
  recipient: null, code: '', sending: false, verifying: false,
  expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null,
};

const OTP_TTL_MS = 10 * 60_000;
const OTP_LENGTH_RE = /^\d{6}$/;

interface Options {
  // The location that owns this recipient. Used in API URLs.
  locationId: string | null;
  // Called after a successful verify so the parent can refetch / update.
  onVerified?: () => void;
}

export function usePhoneVerification({ locationId, onVerified }: Options) {
  const toast = useToast();
  const [state, setState] = useState<PhoneVerificationState>(initialState);

  const close = () => setState(initialState);

  const setCode = (code: string) => setState(s => ({ ...s, code }));

  const start = async (recipient: PhoneRecipient) => {
    if (!locationId || !recipient.phone) return;
    setState({ ...initialState, recipient, sending: true });
    try {
      await sendRecipientOtp(locationId, recipient.id);
      setState(s => ({ ...s, sending: false, expiresAt: Date.now() + OTP_TTL_MS }));
      toast.success(`Code sent to ${recipient.phone}`);
    } catch (err: any) {
      const data = err.response?.data;
      if (data?.reason === 'rate_limited' && data?.retry_at) {
        // Keep dialog open — user can wait or cancel.
        setState(s => ({ ...s, sending: false, retryAt: new Date(data.retry_at).getTime() }));
      } else {
        // Other failures (twilio disabled, network, etc.) — dismiss with snackbar.
        setState(initialState);
        toast.error(data?.error || 'Failed to send verification code');
      }
    }
  };

  const resend = async () => {
    if (!locationId || !state.recipient) return;
    setState(s => ({ ...s, sending: true, retryAt: null }));
    try {
      await sendRecipientOtp(locationId, state.recipient.id);
      setState(s => ({
        ...s,
        sending: false,
        expiresAt: Date.now() + OTP_TTL_MS,
        attemptsRemaining: null, // fresh code resets attempts
      }));
      toast.success('New code sent');
    } catch (err: any) {
      const data = err.response?.data;
      if (data?.reason === 'rate_limited' && data?.retry_at) {
        setState(s => ({ ...s, sending: false, retryAt: new Date(data.retry_at).getTime() }));
      } else {
        setState(s => ({ ...s, sending: false }));
        toast.error(data?.error || 'Failed to resend code');
      }
    }
  };

  const verify = async () => {
    if (!locationId || !state.recipient) return;
    const code = state.code.trim();
    if (!OTP_LENGTH_RE.test(code)) return;
    setState(s => ({ ...s, verifying: true }));
    try {
      await verifyRecipientOtp(locationId, state.recipient.id, code);
      toast.success('Phone verified — SMS/WhatsApp alerts unlocked');
      setState(initialState);
      onVerified?.();
    } catch (err: any) {
      const data = err.response?.data;
      if (data?.reason === 'too_many_attempts') {
        setState(initialState);
        toast.error('Too many wrong codes — please ask an admin to send a fresh code or try again later');
      } else if (data?.reason === 'invalid_code') {
        setState(s => ({
          ...s,
          verifying: false,
          attemptsRemaining: typeof data.attempts_remaining === 'number' ? data.attempts_remaining : null,
          code: '',
        }));
      } else {
        setState(s => ({ ...s, verifying: false }));
        toast.error(data?.error || 'Verification failed — check the code and try again');
      }
    }
  };

  return { state, start, resend, verify, close, setCode };
}

// Drives the expires/retry countdown re-render every second while a dialog
// is open. Cheaper than running setInterval at the call site, and the
// hook automatically stops when the recipient is cleared.
export function useTickWhileOpen(open: boolean) {
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);
}

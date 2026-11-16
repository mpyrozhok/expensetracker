import { useEffect, useMemo, useRef, useState } from 'react';
import { todayIso } from '../lib/format.js';
import type { ApiCategory, ApiTransaction, TransactionDraft } from '../lib/types.js';
import { isDirty, validateTransaction, type FieldErrors } from '../lib/validation.js';
import { Field } from './ui.js';

interface TransactionModalProps {
  open: boolean;
  transaction: ApiTransaction | null;
  categories: ApiCategory[];
  defaultDate: string;
  onClose: () => void;
  onSaved: (payload: Record<string, string | number | null>) => Promise<void>;
  onError: (message: string) => void;
}

function emptyDraft(defaultDate: string, categoryId: number | null): TransactionDraft {
  return {
    title: '',
    amount: '',
    currency: 'USD',
    date: defaultDate,
    category_id: categoryId === null ? '' : String(categoryId),
    notes: '',
  };
}

function draftFrom(transaction: ApiTransaction): TransactionDraft {
  return {
    title: transaction.title,
    amount: String(transaction.amount),
    currency: transaction.currency,
    date: transaction.date,
    category_id: transaction.category_id === null ? '' : String(transaction.category_id),
    notes: transaction.notes,
  };
}

export function TransactionModal(props: TransactionModalProps): React.JSX.Element | null {
  const editing = props.transaction;
  const fallbackCategory = props.categories[0]?.id ?? null;
  const initial = useMemo(
    () => (editing ? draftFrom(editing) : emptyDraft(props.defaultDate || todayIso(), fallbackCategory)),
    [editing, props.defaultDate, fallbackCategory],
  );

  const [draft, setDraft] = useState<TransactionDraft>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setDraft(initial);
    setErrors({});
    titleRef.current?.focus();
  }, [props.open, initial]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  const set = (patch: Partial<TransactionDraft>): void => {
    setDraft((previous) => ({ ...previous, ...patch }));
    // Clear the error for whichever fields changed, so the form feels alive.
    setErrors((previous) => {
      const next = { ...previous };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    const found = validateTransaction(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      await props.onSaved({
        title: draft.title.trim(),
        // The API takes a decimal string; parsing here would reintroduce float
        // error, so the string is sent as typed and the backend stores cents.
        amount: draft.amount.trim(),
        currency: 'USD',
        date: draft.date,
        category_id: Number(draft.category_id),
        notes: draft.notes.trim(),
      });
      props.onClose();
    } catch (failure) {
      props.onError(failure instanceof Error ? failure.message : 'Could not save the transaction');
    } finally {
      setSaving(false);
    }
  };

  const changed = isDirty(draft, initial);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="tx-modal-title">
        <div className="modal__head">
          <h2 id="tx-modal-title">{editing ? 'Edit transaction' : 'Add transaction'}</h2>
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label="Title" htmlFor="tx-title" error={errors.title}>
            <input
              id="tx-title"
              ref={titleRef}
              className={errors.title ? 'input input--invalid' : 'input'}
              value={draft.title}
              maxLength={200}
              aria-invalid={errors.title !== undefined}
              onChange={(event) => set({ title: event.target.value })}
              placeholder="Groceries at the market"
            />
          </Field>

          <div className="grid grid--form">
            <Field label="Amount" htmlFor="tx-amount" error={errors.amount} hint="US dollars, up to 2 decimals.">
              <span className="input-group">
                <span className="input-group__prefix" aria-hidden="true">
                  $
                </span>
                <input
                  id="tx-amount"
                  className={errors.amount ? 'input input--invalid' : 'input'}
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.amount}
                  aria-invalid={errors.amount !== undefined}
                  onChange={(event) => set({ amount: event.target.value })}
                  placeholder="24.99"
                />
              </span>
            </Field>

            <Field label="Date" htmlFor="tx-date" error={errors.date}>
              <input
                id="tx-date"
                className={errors.date ? 'input input--invalid' : 'input'}
                type="date"
                value={draft.date}
                aria-invalid={errors.date !== undefined}
                onChange={(event) => set({ date: event.target.value })}
              />
            </Field>

            <Field label="Category" htmlFor="tx-category" error={errors.category_id}>
              <select
                id="tx-category"
                className="select"
                value={draft.category_id}
                aria-invalid={errors.category_id !== undefined}
                onChange={(event) => set({ category_id: event.target.value })}
              >
                <option value="">Select a category…</option>
                {props.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Notes" htmlFor="tx-notes" error={errors.notes} hint="Optional. Shown under the title.">
            <textarea
              id="tx-notes"
              className={errors.notes ? 'textarea textarea--invalid' : 'textarea'}
              value={draft.notes}
              maxLength={2000}
              aria-invalid={errors.notes !== undefined}
              onChange={(event) => set({ notes: event.target.value })}
            />
          </Field>

          {props.categories.length === 0 ? (
            <p className="banner banner--info">
              Create a category first — every transaction is filed under one, which is what makes the budget and
              category breakdown work.
            </p>
          ) : null}

          <div className="modal__foot">
            <button type="button" className="btn btn--secondary" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={saving || (editing !== null && !changed)}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add transaction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { useState } from 'react';
import type { ApiCategory } from '../lib/types.js';
import { validateCategoryName } from '../lib/validation.js';
import { EmptyState, ErrorBanner, Field, LoadingBlock } from './ui.js';

interface CategoriesProps {
  categories: ApiCategory[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: number, name: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

/**
 * Category management.
 *
 * Deletion policy (documented in the README): a category that is still
 * referenced by at least one transaction cannot be deleted, because silently
 * orphaning or mass-reassigning transactions would rewrite the user's history.
 * The row explains the count instead of offering a destructive shortcut, and a
 * server-side refusal is shown next to the row it applies to rather than in a
 * page-level toast.
 */
export function Categories(props: CategoriesProps): React.JSX.Element {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (): Promise<void> => {
    const invalid = validateCategoryName(name);
    setError(invalid);
    if (invalid !== null) return;
    setBusy(true);
    try {
      await props.onCreate(name.trim());
      setName('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create the category');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="categories-heading">
      <div className="card__head">
        <h2 id="categories-heading">Categories</h2>
        <span className="card__subtitle">Used to group transactions and break down spending</span>
      </div>

      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="field">
          <Field label="New category" htmlFor="new-category" error={error ?? undefined} hint="Names are unique per account, case-insensitive.">
            <input
              id="new-category"
              className={error ? 'input input--invalid' : 'input'}
              value={name}
              maxLength={60}
              placeholder="Groceries"
              aria-invalid={error !== null}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError(null);
              }}
            />
          </Field>
        </div>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Adding…' : 'Add category'}
        </button>
      </form>

      {props.error ? <ErrorBanner message={props.error} onRetry={props.onRetry} /> : null}

      {props.loading ? <LoadingBlock rows={4} /> : null}

      {!props.loading && props.categories.length === 0 ? (
        <EmptyState
          icon="🏷"
          title="No categories yet"
          body="Add a few to get started — for example Groceries, Transport, Bills and Entertainment."
        />
      ) : null}

      {!props.loading && props.categories.length > 0 ? (
        <ul className="cat-list">
          {props.categories.map((category) => (
            <CategoryRow key={category.id} category={category} onRename={props.onRename} onDelete={props.onDelete} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CategoryRow(props: {
  category: ApiCategory;
  onRename: (id: number, name: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.category.name);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const inUse = props.category.transaction_count > 0;

  const commit = async (): Promise<void> => {
    const invalid = validateCategoryName(value);
    if (invalid !== null) {
      setRowError(invalid);
      return;
    }
    setBusy(true);
    try {
      await props.onRename(props.category.id, value.trim());
      setRowError(null);
      setEditing(false);
    } catch (failure) {
      setRowError(failure instanceof Error ? failure.message : 'Could not rename the category');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await props.onDelete(props.category.id);
      setRowError(null);
    } catch (failure) {
      setRowError(failure instanceof Error ? failure.message : 'Could not delete the category');
    } finally {
      setBusy(false);
    }
  };

  const count = props.category.transaction_count;

  return (
    <li className="cat-row">
      {rowError ? (
        <span className="field__error cat-row__error" role="alert">
          {rowError}
        </span>
      ) : null}
      {editing ? (
        <form
          className="row row--tight"
          onSubmit={(event) => {
            event.preventDefault();
            void commit();
          }}
        >
          <label className="visually-hidden" htmlFor={`cat-${String(props.category.id)}`}>
            Rename category
          </label>
          <input
            id={`cat-${String(props.category.id)}`}
            className="input"
            value={value}
            maxLength={60}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="submit" className="btn btn--sm" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <span className="cat-row__name">{props.category.name}</span>
          <span className={inUse ? 'badge badge--primary' : 'badge'}>
            {String(count)} transaction{count === 1 ? '' : 's'}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => {
              setValue(props.category.name);
              setEditing(true);
            }}
            aria-label={`Rename ${props.category.name}`}
          >
            Rename
          </button>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => void remove()}
            disabled={busy || inUse}
            aria-label={`Delete ${props.category.name}`}
            title={
              inUse
                ? `Move or delete its ${String(count)} transaction${count === 1 ? '' : 's'} first — deleting would rewrite history`
                : undefined
            }
          >
            Delete
          </button>
        </>
      )}
    </li>
  );
}

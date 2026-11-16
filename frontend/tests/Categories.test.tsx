// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Categories } from '../src/components/Categories.js';
import { category } from './fixtures.js';

function renderCategories(overrides: Partial<React.ComponentProps<typeof Categories>> = {}) {
  const props = {
    categories: [category({ id: 1, name: 'Groceries', transaction_count: 3 })],
    loading: false,
    error: null,
    onRetry: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<Categories {...props} />);
  return props;
}

describe('Categories', () => {
  it('lists each category with how many transactions reference it', () => {
    renderCategories({
      categories: [
        category({ id: 1, name: 'Groceries', transaction_count: 3 }),
        category({ id: 2, name: 'Travel', transaction_count: 0 }),
      ],
    });
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('3 transactions')).toBeInTheDocument();
    expect(screen.getByText('Travel')).toBeInTheDocument();
    expect(screen.getByText('0 transactions')).toBeInTheDocument();
  });

  it('shows an onboarding empty state when there are none', () => {
    renderCategories({ categories: [] });
    expect(screen.getByText(/no categories yet/i)).toBeInTheDocument();
    expect(screen.getByText(/add a few to get started/i)).toBeInTheDocument();
  });

  it('shows a loading state rather than a false empty state', () => {
    renderCategories({ categories: [], loading: true });
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    expect(screen.queryByText(/no categories yet/i)).not.toBeInTheDocument();
  });

  it('creates a category with a trimmed name', async () => {
    const props = renderCategories();

    await userEvent.type(screen.getByLabelText('New category'), '  Groceries  ');
    await userEvent.click(screen.getByRole('button', { name: /add category/i }));

    expect(props.onCreate).toHaveBeenCalledWith('Groceries');
  });

  it('blocks an empty name client-side before hitting the API', async () => {
    const props = renderCategories();

    await userEvent.click(screen.getByRole('button', { name: /add category/i }));

    expect(screen.getByText('Category name is required')).toBeInTheDocument();
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it('renames inline and only sends the new name', async () => {
    const props = renderCategories();

    await userEvent.click(screen.getByRole('button', { name: 'Rename Groceries' }));
    await userEvent.clear(screen.getByLabelText('Rename category'));
    await userEvent.type(screen.getByLabelText('Rename category'), 'Household');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(props.onRename).toHaveBeenCalledWith(1, 'Household');
  });

  it('cancels an inline rename without calling the API', async () => {
    const props = renderCategories();

    await userEvent.click(screen.getByRole('button', { name: 'Rename Groceries' }));
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Rename Groceries' })).toBeInTheDocument();
  });

  it('deletes an unused category', async () => {
    const props = renderCategories({ categories: [category({ id: 2, name: 'Travel', transaction_count: 0 })] });

    await userEvent.click(screen.getByRole('button', { name: 'Delete Travel' }));

    expect(props.onDelete).toHaveBeenCalledWith(2);
  });

  /**
   * Documented deletion policy: an in-use category cannot be deleted, and the
   * UI says why instead of offering a destructive shortcut.
   */
  it('refuses to delete an in-use category and explains the reason', () => {
    const props = renderCategories({ categories: [category({ id: 1, name: 'Groceries', transaction_count: 4 })] });

    const remove = screen.getByRole('button', { name: 'Delete Groceries' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'Move or delete its 4 transactions first — deleting would rewrite history');
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('renders the server reason when deletion is refused anyway', async () => {
    renderCategories({
      categories: [category({ id: 2, name: 'Travel', transaction_count: 0 })],
      onDelete: vi.fn().mockRejectedValue(new Error('Category still has 2 transactions')),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Delete Travel' }));

    expect(screen.getByText('Category still has 2 transactions')).toBeInTheDocument();
  });

  it('offers a retry when the list could not be loaded', () => {
    const props = renderCategories({ categories: [], error: 'Could not load categories', onRetry: vi.fn() });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load categories');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(props.onRetry).not.toHaveBeenCalled();
  });
});

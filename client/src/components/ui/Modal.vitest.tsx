import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Modal } from '@/components/ui/Modal';

function ControlledDialog() {
  const [value, setValue] = useState('');
  return (
    <Modal open onClose={() => undefined} title="Create user">
      <label htmlFor="controlled-name">Name</label>
      <input id="controlled-name" value={value} onChange={(event) => setValue(event.target.value)} />
    </Modal>
  );
}

describe('modal focus stability', () => {
  it('keeps focus in a controlled input after every keystroke instead of moving to the X button', async () => {
    render(<ControlledDialog />);
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    const close = screen.getByRole('button', { name: 'Close dialog' });

    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(document.activeElement).not.toBe(close);

    for (const value of ['A', 'Ad', 'Adm', 'Admin']) {
      fireEvent.change(input, { target: { value } });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe(value);
    }
  });

  it('restores focus to the opener only after the dialog closes', async () => {
    function ClosableDialog() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open users</button>
          <Modal open={open} onClose={() => setOpen(false)} title="Users">
            <button type="button" onClick={() => setOpen(false)}>Close users</button>
          </Modal>
        </>
      );
    }
    const user = render(<ClosableDialog />);
    const opener = screen.getByRole('button', { name: 'Open users' });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close users' })));
    fireEvent.click(screen.getByRole('button', { name: 'Close users' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    user.unmount();
  });
});

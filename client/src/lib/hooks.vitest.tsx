import { useRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { focusField, handleEnterToNext } from '@/lib/hooks';
import { KshInput } from '@/components/ui/Form';

function FiveFieldSequence() {
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);
  const third = useRef<HTMLInputElement>(null);
  const fourth = useRef<HTMLInputElement>(null);
  const fifth = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={first} aria-label="first" onKeyDown={(event) => handleEnterToNext(event, second)} />
      <input ref={second} aria-label="second" onKeyDown={(event) => handleEnterToNext(event, third)} />
      <input ref={third} aria-label="third" onKeyDown={(event) => handleEnterToNext(event, fourth)} />
      <input ref={fourth} aria-label="fourth" onKeyDown={(event) => handleEnterToNext(event, fifth)} />
      <input ref={fifth} aria-label="fifth" />
    </>
  );
}

describe('keyboard-first data entry', () => {
  it('moves through 100 → 250 → 500 → 750 → 1000 without clicking another field', () => {
    render(<FiveFieldSequence />);
    const fields = ['first', 'second', 'third', 'fourth', 'fifth'].map((label) => screen.getByLabelText(label) as HTMLInputElement);
    const values = ['100', '250', '500', '750', '1000'];
    fields[0]?.focus();

    values.forEach((value, index) => {
      const field = fields[index];
      if (!field) throw new Error(`Missing field ${index}`);
      if (index > 0) expect(document.activeElement).toBe(field);
      fireEvent.change(field, { target: { value } });
      expect(field.value).toBe(value);
      if (index < values.length - 1) fireEvent.keyDown(field, { key: 'Enter' });
    });

    expect(fields.map((field) => field.value)).toEqual(values);
    expect(document.activeElement).toBe(fields[4]);
  });

  it('invokes a submit callback when Enter reaches the end of a logical section', () => {
    const submitted = vi.fn();
    const { rerender } = render(<input aria-label="amount" onKeyDown={(event) => handleEnterToNext(event, undefined, submitted)} />);
    fireEvent.keyDown(screen.getByLabelText('amount'), { key: 'Enter' });
    expect(submitted).toHaveBeenCalledOnce();

    submitted.mockClear();
    rerender(<input aria-label="amount" onKeyDown={(event) => handleEnterToNext(event, undefined, submitted)} />);
    fireEvent.keyDown(screen.getByLabelText('amount'), { key: 'Enter', shiftKey: true });
    expect(submitted).not.toHaveBeenCalled();
  });

  it('keeps a touch-focused KSh field visible above the mobile keyboard', async () => {
    const originalMatchMedia = window.matchMedia;
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockReturnValue({ matches: true }) });
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      render(<KshInput aria-label="mobile amount" defaultValue="500" />);
      const input = screen.getByLabelText('mobile amount') as HTMLInputElement;
      focusField(input, true);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' })));
      expect(input.inputMode).toBe('decimal');
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
      Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: originalScrollIntoView });
    }
  });

  it('selects an existing KSh amount when focus arrives for replacement typing', () => {
    const ref = { current: null as HTMLInputElement | null };
    render(<KshInput ref={ref} defaultValue="1250.50" aria-label="cash amount" />);
    const input = screen.getByLabelText('cash amount') as HTMLInputElement;
    focusField(ref, true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
});

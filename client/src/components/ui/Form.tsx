import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

export const fieldClass = 'w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:disabled:bg-slate-800';

interface FieldProps {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

export function Field({ id, label, error, hint, required, children, className = '' }: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-slate-700 dark:text-slate-200">
        {label}{required && <span className="ml-1 text-red-600" aria-hidden="true">*</span>}
      </label>
      {children}
      {hint && !error && <p id={`${id}-hint`} className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</p>}
      {error && <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400" role="alert">{error}</p>}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  prefix?: string;
  suffix?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', invalid, prefix, suffix, ...props },
  ref,
) {
  const input = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={`${fieldClass} ${invalid ? 'border-red-500 focus:border-red-600 focus:ring-red-500/20' : ''} ${prefix ? 'rounded-l-none' : ''} ${suffix ? 'rounded-r-none' : ''} ${className}`}
      {...props}
    />
  );
  if (!prefix && !suffix) return input;
  return (
    <div className="flex">
      {prefix && <span className="inline-flex items-center rounded-l-xl border border-r-0 border-slate-300 bg-slate-100 px-3 text-sm font-bold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">{prefix}</span>}
      {input}
      {suffix && <span className="inline-flex items-center rounded-r-xl border border-l-0 border-slate-300 bg-slate-100 px-3 text-xs font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">{suffix}</span>}
    </div>
  );
});

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<SelectOption | string>;
  placeholder?: string;
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, invalid, className = '', ...props },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={`${fieldClass} appearance-none pr-10 ${invalid ? 'border-red-500' : ''} ${className}`}
        {...props}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => {
          const item = typeof option === 'string' ? { value: option, label: option } : option;
          return <option key={item.value} value={item.value}>{item.label}</option>;
        })}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className = '', ...props },
  ref,
) {
  return <textarea ref={ref} className={`${fieldClass} min-h-24 resize-y ${className}`} {...props} />;
});

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  description?: string;
}

export function Checkbox({ label, description, id, className = '', ...props }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  return (
    <label htmlFor={inputId} className={`flex cursor-pointer items-start gap-3 ${className}`}>
      <input id={inputId} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600 dark:border-slate-600 dark:bg-slate-900" {...props} />
      <span>
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{description}</span>}
      </span>
    </label>
  );
}

export function KshInput(props: InputProps) {
  return <Input type="number" min="0" step="0.01" inputMode="decimal" prefix="KSh" {...props} />;
}

interface DateRangeProps {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  error?: string | null;
  max?: string;
}

export function DateRange({ from, to, onChange, error, max }: DateRangeProps) {
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="date-from" label="From">
          <Input id="date-from" type="date" value={from} max={to || max} onChange={(event) => onChange(event.target.value, to)} invalid={Boolean(error)} />
        </Field>
        <Field id="date-to" label="To">
          <Input id="date-to" type="date" value={to} min={from} max={max} onChange={(event) => onChange(from, event.target.value)} invalid={Boolean(error)} />
        </Field>
      </div>
      {error && <p className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400" role="alert">{error}</p>}
    </div>
  );
}

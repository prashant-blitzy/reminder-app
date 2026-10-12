/**
 * The create form: the reminder's text, its due date and time, the inline message for a refused
 * input, and the one notification-permission request this application ever spends.
 *
 * The form owns exactly two things — the three values the user has typed and the message currently on
 * screen about them — and nothing else. It holds no reminder data, issues no request of its own,
 * never touches the list and renders no banner: the create call is the `create` prop, so the parent
 * keeps the API call, the list update and the screen's single error banner. Nothing is inserted
 * optimistically, here or anywhere: the list changes only from the parent's server response, which is
 * why a failed create leaves both the list and this form's values exactly as they were.
 *
 * Every rule this form follows lives in a module it only calls, so no behaviour is re-implemented and
 * none can drift:
 *
 * - What is acceptable comes from `../lib/validation`. `validateReminderInput` returns either the
 *   request body — exactly `text` and `dueAt`, the only two keys a create request may carry — or the
 *   single refusal to show, attributed to the input that caused it; `MAX_TEXT_LENGTH` is the bound the
 *   live counter counts against, so the bound is stated once in the client. No rule and no message
 *   string is written in this file.
 * - The instant the due time is judged against comes from `../lib/time`, the client's single clock
 *   read, taken once inside the submit handler. This file contains no `Date` construction and no clock
 *   read of its own, and it never converts a date or a time: `../lib/validation` calls the one
 *   converter.
 * - What the notification channel currently permits comes from `../lib/notifications`, the only module
 *   that reads or requests permission. This form spends the request — riding the submit gesture, only
 *   from a `default` reading, never on page load and never from `denied` — and decides nothing further
 *   about channels; the alert surface belongs to another component.
 * - Why a request failed comes from `../lib/remindersApi`'s `ApiError`. Its `message` is what the user
 *   reads on that path, and its `field` decides which input the message is shown under. When the error
 *   names no field the message is shown at form level, because guessing a field would point the user at
 *   an input that may have nothing to do with the failure.
 *
 * The submit flow, in order, because the order carries meaning:
 *
 * 1. The submit's default action is prevented and the previous messages are cleared.
 * 2. The three inputs are read and the current instant is taken, once.
 * 3. The values are validated. A refusal is rendered under the field it names, that field is focused,
 *    and no request is sent at all.
 * 4. A `default` channel reading spends the one permission request, fire-and-forget and synchronously
 *    inside this handler, so the browser counts it as user-activated and the reminder's creation never
 *    waits on a prompt.
 * 5. Otherwise the create request is awaited: success clears the three inputs, and any failure keeps
 *    every entered value in place and shows the server's own wording, because the screen must never
 *    present an unsaved reminder as saved.
 *
 * The form is deliberately usable before any style is applied: three labelled inputs inside a real
 * `<form>`, a submit button, a live count of the text, and one message region per input that is always
 * in the document. The messages are polite live regions and each control points at the message that
 * describes it through `aria-describedby`, so a refusal is announced without the user having to go
 * looking for it; a rejected submit also focuses the first control the user has to correct, so the
 * correction path and the focus order agree.
 *
 * The class names are the fixed vocabulary `client/src/styles.css` carries a rule for:
 * `reminder-form`, `reminder-form__field`, `reminder-form__label`, `reminder-form__input`,
 * `reminder-form__counter`, `reminder-form__error` and `reminder-form__submit`. Nothing else is
 * invented here and no style is declared in this file. The stylesheet also gives
 * `.reminder-form__field` a free width at the first position and a narrow basis at the second and
 * third, which is why the three field wrappers are the form's first three children and the counter is
 * not one of them.
 */

import { useId, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, JSX } from 'react';

import { getChannelSnapshot, requestPermission } from '../lib/notifications';
import { ApiError } from '../lib/remindersApi';
import { currentInstantIso } from '../lib/time';
import { MAX_TEXT_LENGTH, VALIDATION_MESSAGES, validateReminderInput } from '../lib/validation';
import type { ReminderFormValues } from '../lib/validation';
import type { CreateReminderInput, Reminder } from '../types';

/**
 * The props this form renders from and delegates to.
 *
 * One property, deliberately: the form creates reminders through the parent rather than through the
 * HTTP layer, so the parent owns the request, the loading and error state, and the list. Every
 * property is required — a form that cannot create anything would silently do nothing on submit.
 */
export interface ReminderFormProps {
  /**
   * Creates one reminder and resolves the created record.
   *
   * Wired by the parent to `client/src/lib/remindersApi.ts`, which is the client's only HTTP caller,
   * and rejects with that module's `ApiError` — whose `message` the user reads and whose `field`
   * decides which input the message appears under.
   */
  create: (input: CreateReminderInput) => Promise<Reminder>;
}

/**
 * The input a refusal can be attributed to: the two values the request body is made of, named as the
 * validation module and the server's error body name them.
 *
 * The due date and the due time are one field in this vocabulary, because they form one value: the
 * absolute instant the reminder is due. They are two controls on screen, so a refusal attributed to
 * `dueAt` is shown once, under the pair, and both controls point at that message.
 */
type RejectionField = 'text' | 'dueAt';

/**
 * The message currently on screen, and the field it belongs to.
 *
 * `field` is absent for a failure that belongs to no single input — a request that never reached the
 * server, or one the server refused without naming a field — and such a message is rendered at form
 * level. The property admits an explicit `undefined` for the same reason the API error body does: this
 * workspace compiles with `exactOptionalPropertyTypes`, so the value a field-less error carries must be
 * assignable here.
 */
interface Rejection {
  /** The wording to show: the validation module's message, or the server's own. */
  message: string;

  /** The input the message belongs under, or absent for a form-level message. */
  field?: RejectionField | undefined;
}

/**
 * Reads a caught failure as the message to show and the field to attribute it to.
 *
 * An `ApiError` carries both: the wording the server sent (or the generic wording when the request
 * never reached the server) and the field it named, if it named one. Anything else thrown by the
 * `create` prop is reported with the generic wording under no field, because a failure the form
 * cannot attribute is a failure it must not point at an input — and because a raw error's message is
 * the one string that could carry something the user should not be shown.
 *
 * @param error Whatever the `create` prop rejected with.
 * @returns The message to render and the field to render it under.
 */
function rejectionFrom(error: unknown): Rejection {
  if (error instanceof ApiError) {
    return { message: error.message, field: error.field };
  }

  return { message: VALIDATION_MESSAGES.GENERIC_ERROR };
}

/**
 * The create form.
 *
 * @param props The one thing this form delegates to: the parent's create call.
 * @returns The form: the three labelled inputs with their message lines, the live character count,
 *   the `Add reminder` submit control, and — when a failure named no input — one form-level message.
 */
export function ReminderForm({ create }: ReminderFormProps): JSX.Element {
  // The three values the user has typed, exactly as typed: the text untrimmed (the rule trims it) and
  // the two platform picker strings, never an instant.
  const [text, setText] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');

  // The one message on screen: the validation module's refusal, or the server's failure. A single
  // piece of state rather than one per field, so a new submit can never leave a previous refusal
  // standing beside a new one.
  const [rejection, setRejection] = useState<Rejection | null>(null);

  // True only while a create request is on the wire. It disables the submit control and, with the
  // in-flight guard below, keeps one submit from producing two reminders.
  const [submitting, setSubmitting] = useState(false);

  // The three controls, so a rejected submit can focus the one the user has to correct without
  // querying the document.
  const textInput = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const timeInput = useRef<HTMLInputElement>(null);

  // Guards against a second submit arriving before React has re-rendered the disabled button — an
  // Enter key press in a text input can submit the form without the button being activated again.
  const submitInFlight = useRef(false);

  // The unique prefix for this form's control and message ids, so the label associations and the
  // `aria-describedby` references stay correct even if two forms are ever mounted together.
  const fieldIdBase = useId();
  const textInputId = `${fieldIdBase}-text`;
  const dateInputId = `${fieldIdBase}-date`;
  const timeInputId = `${fieldIdBase}-time`;
  const textMessageId = `${fieldIdBase}-text-message`;
  const dueMessageId = `${fieldIdBase}-due-message`;

  // The message each region renders, which is also what decides whether that region is non-empty and
  // whether its control is marked invalid. At most one of the three is ever non-empty.
  const textMessage = rejection !== null && rejection.field === 'text' ? rejection.message : '';
  const dueMessage = rejection !== null && rejection.field === 'dueAt' ? rejection.message : '';
  const formMessage = rejection !== null && rejection.field === undefined ? rejection.message : '';

  /**
   * Drops the message on screen when it belongs to the field being edited, so a refusal the user has
   * begun to correct stops accusing them, while a form-level message — which belongs to no field —
   * stays until the next submit replaces it.
   */
  function clearRejectionFor(field: RejectionField): void {
    setRejection((current) => (current !== null && current.field === field ? null : current));
  }

  /** Records the typed text and clears the text field's message. */
  function handleTextChange(event: ChangeEvent<HTMLInputElement>): void {
    setText(event.target.value);
    clearRejectionFor('text');
  }

  /** Records the picked date and clears the due-time message, which covers both of its controls. */
  function handleDateChange(event: ChangeEvent<HTMLInputElement>): void {
    setDate(event.target.value);
    clearRejectionFor('dueAt');
  }

  /** Records the picked time and clears the due-time message, which covers both of its controls. */
  function handleTimeChange(event: ChangeEvent<HTMLInputElement>): void {
    setTime(event.target.value);
    clearRejectionFor('dueAt');
  }

  /**
   * Moves focus to the control the user has to correct after a refusal.
   *
   * The due date and time are one value in two controls, so a refusal attributed to the pair focuses
   * the first of them that is still empty — the control the user has yet to fill in — and, when both
   * already hold a value (a due time in the past), the pair's first control, which matches the order
   * the controls appear in and the order they are read in.
   */
  function focusField(field: RejectionField): void {
    if (field === 'text') {
      textInput.current?.focus();
      return;
    }

    const dateControl = dateInput.current;
    const timeControl = timeInput.current;

    if (dateControl === null || timeControl === null) {
      return;
    }

    if (dateControl.value === '') {
      dateControl.focus();
      return;
    }

    if (timeControl.value === '') {
      timeControl.focus();
      return;
    }

    dateControl.focus();
  }

  /**
   * Handles a submit of the create form.
   *
   * The order is the contract: prevent the default action and clear the previous messages, read the
   * inputs and the current instant, validate, and — only for a valid submission — spend the one
   * permission request and then create the reminder. A refused submission returns before any request
   * exists, so nothing is saved and the user is left standing on the field that needs fixing.
   *
   * A failed create keeps every entered value: the user's text, date and time survive, and the
   * server's own message is shown under the input it named (or at form level when it named none).
   *
   * @param event The form's submit event.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    // One submit in flight at a time: a second would create a second reminder, since this form never
    // inserts optimistically and therefore has nothing on screen to deduplicate against.
    if (submitInFlight.current) {
      return;
    }

    setRejection(null);

    const values: ReminderFormValues = { text, date, time };
    const result = validateReminderInput(values, currentInstantIso());

    if (!result.ok) {
      setRejection({ field: result.failure.field, message: result.failure.message });
      focusField(result.failure.field);
      return;
    }

    // The one permission request this application spends, riding the submit gesture because the
    // platform requires one. Only a `default` reading asks: `granted` has nothing left to ask for,
    // `denied` is never re-requested because a repeated request cannot succeed, and an absent API has
    // nothing to ask. It is deliberately not awaited — the reminder's creation must not wait on a
    // prompt — and it stays synchronous in this handler so the browser counts the submit as the
    // gesture that activated it.
    if (getChannelSnapshot().permission === 'default') {
      void requestPermission();
    }

    submitInFlight.current = true;
    setSubmitting(true);

    try {
      await create(result.input);

      // Cleared only after the server has confirmed the reminder: the form is never emptied on an
      // assumption, so nothing the user typed is lost to a failure.
      setText('');
      setDate('');
      setTime('');
      setRejection(null);
    } catch (error) {
      // The values stay exactly as the user left them, and the message is the server's own wording,
      // attributed to the input the server named.
      setRejection(rejectionFrom(error));
    } finally {
      submitInFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form className="reminder-form" onSubmit={handleSubmit}>
      {/* The three field wrappers are the form's first three children, in the plan's order — reminder
          text, then due date, then due time — because the stylesheet gives the first of them the free
          width of the row and the second and third a narrow basis
          (`.reminder-form__field:nth-child(2)`, `:nth-child(3)`). Each wrapper carries its own message
          line, reserved whether or not it holds text, so a rejected submit never moves the controls. */}
      <div className="reminder-form__field">
        <label className="reminder-form__label" htmlFor={textInputId}>
          Reminder text
        </label>

        <input
          className="reminder-form__input"
          id={textInputId}
          ref={textInput}
          type="text"
          value={text}
          onChange={handleTextChange}
          aria-invalid={textMessage !== ''}
          aria-describedby={textMessageId}
        />

        <p className="reminder-form__error" id={textMessageId} aria-live="polite">
          {textMessage}
        </p>
      </div>

      <div className="reminder-form__field">
        <label className="reminder-form__label" htmlFor={dateInputId}>
          Due date
        </label>

        {/* The due date and due time are one value in two controls, so a refusal of that value is
            rendered once, under the second of the pair, and both controls point at it. */}
        <input
          className="reminder-form__input"
          id={dateInputId}
          ref={dateInput}
          type="date"
          value={date}
          onChange={handleDateChange}
          aria-invalid={dueMessage !== ''}
          aria-describedby={dueMessageId}
        />

        <p className="reminder-form__error" aria-live="polite" />
      </div>

      <div className="reminder-form__field">
        <label className="reminder-form__label" htmlFor={timeInputId}>
          Due time
        </label>

        <input
          className="reminder-form__input"
          id={timeInputId}
          ref={timeInput}
          type="time"
          value={time}
          onChange={handleTimeChange}
          aria-invalid={dueMessage !== ''}
          aria-describedby={dueMessageId}
        />

        <p className="reminder-form__error" id={dueMessageId} aria-live="polite">
          {dueMessage}
        </p>
      </div>

      {/* The counter stands outside the field wrappers because their positions are fixed by the
          stylesheet's nth-child rules, and inside the form's row so it reads as an annotation of the
          text field. It counts the characters as typed: the rule measures the trimmed text, which is
          never longer than what is typed, so the count can never under-report the length being
          enforced. */}
      <p className="reminder-form__counter">
        {text.length} of {MAX_TEXT_LENGTH} characters
      </p>

      <button className="reminder-form__submit" type="submit" disabled={submitting}>
        Add reminder
      </button>

      {/* A failure the server attributed to no input — an unreachable server, an unreadable body, a
          storage failure — is shown here rather than pointed at a field it has nothing to do with. */}
      {formMessage === '' ? null : (
        <p className="reminder-form__error" aria-live="polite">
          {formMessage}
        </p>
      )}
    </form>
  );
}

/**
 * Default export of the same component.
 *
 * `client/src/App.tsx`, the screen that renders this form, is written from a separate brief, so the
 * import form it uses is not knowable from here. Exporting both forms keeps either choice working
 * without an edit to this file: a named import (`import { ReminderForm } from './components/…'`) and a
 * default import both resolve to the single implementation above. There is exactly one component here,
 * not two, and its props are the same either way.
 */
export default ReminderForm;

import { addGoal, deleteGoal, getGoals, onGoalsChange, skipGoalToday, unskipGoalToday, updateGoal } from "./state";
import { buildActivitySelect, buildMinutesInput, buildRecurrencePicker, describeRecurrence, formatMinutes } from "./ui";
import { Goal, Recurrence } from "./types";
import { localDateString } from "./recurrence";
import { buildModal } from "../ui/modal";

function todayDateString(): string {
  return localDateString(new Date());
}

/** Full add/edit/delete/skip UI for every goal, regardless of whether it's scheduled today — opened on demand so the always-visible goals panel can stay small and progress-only. */
export function setupGoalsManageModal(): { open: () => void } {
  const modal = buildModal("Manage Goals", { resizable: true });

  const buttonRow = document.createElement("div");
  buttonRow.id = "goals-button-row";
  modal.body.appendChild(buttonRow);

  const quickAddBtn = document.createElement("button");
  quickAddBtn.textContent = "+ Add Goal";
  quickAddBtn.onclick = () => toggleForm("quick", openQuickAddForm);
  buttonRow.appendChild(quickAddBtn);

  const recurringAddBtn = document.createElement("button");
  recurringAddBtn.textContent = "+ Add Recurring Goal";
  recurringAddBtn.onclick = () => toggleForm("recurring", openRecurringAddForm);
  buttonRow.appendChild(recurringAddBtn);

  const formSlot = document.createElement("div");
  formSlot.id = "goal-form-slot";
  modal.body.appendChild(formSlot);

  const list = document.createElement("div");
  list.id = "goals-manage-list";
  modal.body.appendChild(list);

  let openForm: "quick" | "recurring" | null = null;

  function toggleForm(kind: "quick" | "recurring", build: () => void) {
    formSlot.textContent = "";
    if (openForm === kind) {
      openForm = null;
      return;
    }
    openForm = kind;
    build();
  }

  let confirmingRemovalId: string | null = null;
  let editingGoalId: string | null = null;

  function buildRemoveButton(goal: Goal): HTMLElement {
    // Deleting a recurring goal outright would also erase every future
    // occurrence — offer a choice instead of guessing which one was meant.
    if (goal.recurrence.type !== "once" && confirmingRemovalId === goal.id) {
      const wrap = document.createElement("span");
      wrap.className = "goal-remove-confirm";

      const skipBtn = document.createElement("button");
      skipBtn.className = "goal-remove-option";
      skipBtn.textContent = "Skip today";
      skipBtn.onclick = async () => {
        confirmingRemovalId = null;
        try {
          await skipGoalToday(goal);
        } catch (err) {
          console.error("[goals] failed to skip goal", err);
          render();
        }
      };

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "goal-remove-option";
      deleteBtn.textContent = "Delete";
      deleteBtn.onclick = async () => {
        confirmingRemovalId = null;
        try {
          await deleteGoal(goal.id);
        } catch (err) {
          console.error("[goals] failed to remove goal", err);
          render();
        }
      };

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "goal-remove-option";
      cancelBtn.textContent = "Cancel";
      cancelBtn.onclick = () => {
        confirmingRemovalId = null;
        render();
      };

      wrap.append(skipBtn, deleteBtn, cancelBtn);
      return wrap;
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "goal-remove";
    removeBtn.textContent = "×";
    removeBtn.onclick = async () => {
      if (goal.recurrence.type !== "once") {
        confirmingRemovalId = goal.id;
        render();
        return;
      }
      removeBtn.disabled = true;
      try {
        await deleteGoal(goal.id);
      } catch (err) {
        console.error("[goals] failed to remove goal", err);
        removeBtn.disabled = false;
      }
    };
    return removeBtn;
  }

  function buildEditForm(goal: Goal): HTMLElement {
    const form = document.createElement("span");
    form.className = "goal-edit-form";

    const activitySelect = buildActivitySelect();
    activitySelect.value = goal.activityLabel;
    form.appendChild(activitySelect);

    const minutesInput = buildMinutesInput(goal.targetMinutes);
    form.appendChild(minutesInput);

    // A one-off goal's date is fixed to the day it was added for — only its
    // target (and now activity) is editable. Recurring goals can also have
    // their schedule changed.
    const picker = goal.recurrence.type !== "once" ? buildRecurrencePicker(goal.recurrence) : null;
    if (picker) form.appendChild(picker.element);

    const saveBtn = document.createElement("button");
    saveBtn.className = "goal-edit-option";
    saveBtn.textContent = "Save";
    saveBtn.onclick = async () => {
      const targetMinutes = Number(minutesInput.value);
      if (!targetMinutes || targetMinutes <= 0) return;
      const recurrence = picker ? picker.getRecurrence() : goal.recurrence;
      if (!recurrence) return;

      saveBtn.disabled = true;
      try {
        editingGoalId = null;
        await updateGoal(goal.id, activitySelect.value, targetMinutes, recurrence);
      } catch (err) {
        console.error("[goals] failed to update goal", err);
        editingGoalId = goal.id;
        saveBtn.disabled = false;
        render();
      }
    };
    form.appendChild(saveBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "goal-edit-option";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => {
      editingGoalId = null;
      render();
    };
    form.appendChild(cancelBtn);

    return form;
  }

  function buildGoalManageRow(goal: Goal): HTMLElement {
    const row = document.createElement("div");
    row.className = "goal-manage-row";

    if (editingGoalId === goal.id) {
      row.appendChild(buildEditForm(goal));
      return row;
    }

    const skippedToday = goal.recurrence.type !== "once" && (goal.skipDates?.includes(todayDateString()) ?? false);

    const text = document.createElement("span");
    text.className = "goal-manage-text";
    text.textContent = `${goal.activityLabel} — ${formatMinutes(goal.targetMinutes)} — ${describeRecurrence(goal.recurrence)}${skippedToday ? " (skipped today)" : ""}`;
    row.appendChild(text);

    const editBtn = document.createElement("button");
    editBtn.className = "goal-edit";
    editBtn.textContent = "✎";
    editBtn.onclick = () => {
      editingGoalId = goal.id;
      render();
    };
    row.appendChild(editBtn);

    if (skippedToday) {
      const undoBtn = document.createElement("button");
      undoBtn.className = "goal-edit-option";
      undoBtn.textContent = "Undo skip";
      undoBtn.onclick = async () => {
        undoBtn.disabled = true;
        try {
          await unskipGoalToday(goal);
        } catch (err) {
          console.error("[goals] failed to undo skip", err);
          undoBtn.disabled = false;
        }
      };
      row.appendChild(undoBtn);
    }

    row.appendChild(buildRemoveButton(goal));
    return row;
  }

  function renderSection(title: string, sectionGoals: Goal[]) {
    if (sectionGoals.length === 0) return;
    const heading = document.createElement("div");
    heading.className = "goal-manage-section-title";
    heading.textContent = title;
    list.appendChild(heading);
    for (const goal of sectionGoals) list.appendChild(buildGoalManageRow(goal));
  }

  function render() {
    const goals = getGoals();

    list.textContent = "";
    if (goals.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No goals yet";
      list.appendChild(empty);
      return;
    }

    renderSection(
      "Today's Goals",
      goals.filter((g) => g.recurrence.type === "once"),
    );
    renderSection(
      "Recurring Goals",
      goals.filter((g) => g.recurrence.type !== "once"),
    );
  }

  function openQuickAddForm() {
    const form = document.createElement("div");
    form.id = "goal-form";

    const activitySelect = buildActivitySelect();
    const minutesInput = buildMinutesInput();
    form.appendChild(activitySelect);
    form.appendChild(minutesInput);

    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Add";
    submitBtn.onclick = async () => {
      const targetMinutes = Number(minutesInput.value);
      if (!targetMinutes || targetMinutes <= 0) return;
      submitBtn.disabled = true; // the save+render round-trip has no other visual feedback — without this, a slow-feeling click just gets repeated
      try {
        await addGoal(activitySelect.value, targetMinutes, { type: "once", date: todayDateString() });
        formSlot.textContent = "";
        openForm = null;
      } catch (err) {
        console.error("[goals] failed to add goal", err);
        submitBtn.disabled = false;
      }
    };
    form.appendChild(submitBtn);

    formSlot.appendChild(form);
  }

  function openRecurringAddForm() {
    const form = document.createElement("div");
    form.id = "goal-form";

    const activitySelect = buildActivitySelect();
    const minutesInput = buildMinutesInput();
    form.appendChild(activitySelect);
    form.appendChild(minutesInput);

    const picker = buildRecurrencePicker(null);
    form.appendChild(picker.element);

    // Always offered, regardless of whether the picked recurrence happens to
    // land on today — lets you start a recurring goal immediately rather
    // than waiting for its schedule to naturally come around.
    const addToTodayLabel = document.createElement("label");
    addToTodayLabel.className = "add-to-today";
    const addToTodayCheckbox = document.createElement("input");
    addToTodayCheckbox.type = "checkbox";
    addToTodayLabel.appendChild(addToTodayCheckbox);
    addToTodayLabel.appendChild(document.createTextNode(" Also add to today"));
    form.appendChild(addToTodayLabel);

    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Add";
    submitBtn.onclick = async () => {
      const targetMinutes = Number(minutesInput.value);
      if (!targetMinutes || targetMinutes <= 0) return;
      const recurrence = picker.getRecurrence();
      if (!recurrence) return;

      submitBtn.disabled = true;
      try {
        await addGoal(activitySelect.value, targetMinutes, recurrence);
        if (addToTodayCheckbox.checked) {
          await addGoal(activitySelect.value, targetMinutes, { type: "once", date: todayDateString() } as Recurrence);
        }
        formSlot.textContent = "";
        openForm = null;
      } catch (err) {
        console.error("[goals] failed to add goal", err);
        submitBtn.disabled = false;
      }
    };
    form.appendChild(submitBtn);

    formSlot.appendChild(form);
  }

  modal.onClose(() => {
    formSlot.textContent = "";
    openForm = null;
    editingGoalId = null;
    confirmingRemovalId = null;
  });

  onGoalsChange(render);
  render();

  return {
    open() {
      modal.open();
      render();
    },
  };
}

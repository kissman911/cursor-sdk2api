import { Button } from "../bflabs/Button";
import type { RosterItem } from "../roster";
import { AccountTable, type PoolStateCopy } from "./AccountTable";
import type { HomeCopy } from "./HomePage";
import { ActionLink, PageFrame } from "./shared";

export function AccountsPage({
  t,
  poolState,
  draftKey,
  addError,
  adding,
  roster,
  onDraft,
  onAdd,
  onTest,
  onRemove,
  onToggleEnabled,
}: {
  t: HomeCopy & { add: string; adding: string; keyPlaceholder: string; keyHelp: string; remove: string; poolHelp: string };
  poolState: PoolStateCopy;
  draftKey: string;
  addError: string;
  adding: boolean;
  roster: RosterItem[];
  onDraft: (value: string) => void;
  onAdd: () => void;
  onTest: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
}) {
  const passed = roster.filter((item) => item.testState === "pass").length;
  const failed = roster.filter((item) => item.testState === "fail").length;
  const resting = roster.filter((item) => item.state !== "active").length;
  return (
    <PageFrame
      kicker={t.manage}
      title={t.authTitle}
      actions={<ActionLink href="#/">{t.dashTitle}</ActionLink>}
    >
      <p className="page-meta">{t.authMeta
        .replace("{total}", String(roster.length))
        .replace("{ok}", String(passed))
        .replace("{bad}", String(failed))}</p>
      <form
        className="add-row page-add"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd();
        }}
      >
        <input
          type="password"
          value={draftKey}
          autoComplete="off"
          spellCheck={false}
          placeholder={t.keyPlaceholder}
          onChange={(event) => onDraft(event.target.value)}
        />
        <Button type="submit" variant="primary" size="sm" loading={adding} disabled={adding}>
          {adding ? t.adding : t.add}
        </Button>
      </form>
      {addError ? <p className="field-error" role="alert">{addError}</p> : null}
      <p className="note">{t.keyHelp}</p>
      <p className="note">{t.poolHelp.replace("{n}", String(resting))}</p>
      {roster.length === 0 ? <p className="empty">{t.noAccounts}</p> : (
        <AccountTable
          items={roster}
          quotaMissing={t.quotaMissing}
          grokBotQuota={t.grokBotQuota}
          grokBotMissing={t.grokBotMissing}
          fableOn={t.fableOn}
          fableOff={t.fableOff}
          fableUnknown={t.fableUnknown}
          testing={t.testing}
          test={t.test}
          testFail={t.testFail}
          open={t.open}
          remove={t.remove}
          headers={t.headers}
          poolState={poolState}
          onTest={onTest}
          onRemove={onRemove}
          onToggleEnabled={onToggleEnabled}
        />
      )}
    </PageFrame>
  );
}

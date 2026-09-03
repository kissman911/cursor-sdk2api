import { Button } from "../bflabs/Button";
import { StatusTag } from "../bflabs/StatusTag";
import { catalogHasFable5 } from "../fable5";
import { hrefFor } from "../nav";
import { formatGrokBotQuota, formatQuota, formatQuotaBreakdown } from "../quota";
import { formatCooldownUntil, identityLabel, type RosterItem } from "../roster";
import { ActionLink } from "./shared";

export interface PoolStateCopy {
  stateDisabled: string;
  stateCooldown: string;
  enable: string;
  disable: string;
  locale: string;
}

export function AccountTable({
  items,
  quotaMissing,
  grokBotQuota,
  grokBotMissing,
  fableOn,
  fableOff,
  fableUnknown,
  testing,
  test,
  testFail,
  open,
  remove,
  headers,
  poolState,
  onTest,
  onRemove,
  onToggleEnabled,
}: {
  items: RosterItem[];
  quotaMissing: string;
  grokBotQuota: string;
  grokBotMissing: string;
  fableOn: string;
  fableOff: string;
  fableUnknown: string;
  testing: string;
  test: string;
  testFail: string;
  open: string;
  remove?: string;
  headers: [string, string, string, string];
  poolState?: PoolStateCopy;
  onTest: (id: string) => void;
  onRemove?: (id: string) => void;
  onToggleEnabled?: (id: string, enabled: boolean) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="grid-table">
        <thead>
          <tr>
            {headers.map((label) => <th key={label}>{label}</th>)}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const quota = formatQuota(item.account);
            const quotaBreakdown = formatQuotaBreakdown(item.account);
            const grokQuota = formatGrokBotQuota(item.account);
            const fable = item.models ? (catalogHasFable5(item.models) ? fableOn : fableOff) : fableUnknown;
            const probe =
              item.testState === "testing"
                ? testing
                : item.testState === "pass"
                  ? `${item.testMs ?? 0} ms`
                  : item.testState === "fail"
                    ? item.testError || testFail
                    : "—";
            const poolTag =
              poolState && item.state === "disabled" ? (
                <StatusTag tone="neutral">{poolState.stateDisabled}</StatusTag>
              ) : poolState && item.state === "cooldown" ? (
                <StatusTag tone="danger" title={item.cooldownReason}>
                  {poolState.stateCooldown.replace("{time}", formatCooldownUntil(item.cooldownUntil, poolState.locale))}
                </StatusTag>
              ) : null;
            return (
              <tr key={item.id} className={item.state !== "active" ? "row-muted" : undefined}>
                <td>
                  <a className="row-link" href={hrefFor("account", item.id)}>
                    <strong>{identityLabel(item.account, item.keyHint)}</strong>
                    <span className="sub">{item.account?.identity?.api_key_name || item.keyHint}</span>
                  </a>
                  {poolTag ? <div className="pool-state">{poolTag}</div> : null}
                </td>
                <td>
                  <span>{quota || quotaMissing}</span>
                  {quotaBreakdown ? <span className="sub quota-breakdown">{quotaBreakdown}</span> : null}
                  <span className="sub quota-breakdown">{grokBotQuota} {grokQuota || grokBotMissing}</span>
                </td>
                <td>{fable}</td>
                <td>{probe}</td>
                <td className="row-actions">
                  <div className="row-action-group">
                    <Button variant="secondary" size="sm" disabled={item.testState === "testing"} onClick={() => onTest(item.id)}>
                      {item.testState === "testing" ? testing : test}
                    </Button>
                    <ActionLink href={hrefFor("account", item.id)}>{open}</ActionLink>
                    {onToggleEnabled && poolState ? (
                      <Button
                        variant="quiet"
                        size="sm"
                        aria-pressed={!item.enabled}
                        onClick={() => onToggleEnabled(item.id, !item.enabled || item.state === "cooldown")}
                      >
                        {item.enabled && item.state !== "cooldown" ? poolState.disable : poolState.enable}
                      </Button>
                    ) : null}
                    {onRemove && remove ? (
                      <Button variant="quiet" size="sm" onClick={() => onRemove(item.id)}>{remove}</Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

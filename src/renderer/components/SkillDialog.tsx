import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../hooks/useLang';

/**
 * THE SKILLS KIRO ACTUALLY HAS — read from `~/.kiro/skills/<name>/SKILL.md`.
 *
 * This panel replaces an earlier version of mine that visualised a `flow.yaml` format I
 * had invented. That was the wrong thing to show: the user's real skill is 20 prose rules
 * with alias tables, conditional branches and per-event interaction, and a five-step
 * declarative pipeline cannot express any of it. Asking someone to restate their workflow
 * in YAML just so it can be drawn is a worse deal than not drawing it.
 *
 * WHAT A KIRO SKILL IS, and therefore what this panel may claim. There is no
 * `kiro-cli skill` command. A skill is markdown whose frontmatter `description` is a
 * TRIGGER ("Use when the user wants to log activities…"); the model reads it, decides the
 * skill applies, pulls the prose into context, and keeps control of the flow. So this is
 * an OBSERVATION surface:
 *
 *   - it shows WHEN each skill fires, because that description is the entire interface
 *     between a skill and the model, and it is otherwise invisible;
 *   - it shows the rules AS NUMBERED IN THE FILE, duplicates and gaps included, so the
 *     panel can never quietly disagree with the document the model reads;
 *   - it marks which rules pause for a human and which write to an external system, as
 *     WARNINGS. Nothing here enforces a word of it -- the model may skip any rule -- and
 *     the footer says so, because a panel that looks like a control surface would be
 *     claiming a guarantee KiroLex does not have.
 */

interface SkillRule {
  number: number;
  label: string;
  text: string;
  interactive: boolean;
  writes: boolean;
}

interface SkillTable {
  section: string;
  headers: string[];
  rows: string[][];
}

interface SkillSection {
  title: string;
  level: number;
  body: string;
  children: SkillSection[];
  tables: SkillTable[];
}

interface SkillDoc {
  name: string | null;
  description: string;
  triggerText: string | null;
  title: string;
  sections: SkillSection[];
  rules: SkillRule[];
  tables: SkillTable[];
}

interface SkillEntry {
  folder: string;
  path: string;
  ok: boolean;
  doc?: SkillDoc;
  summary?: string;
  error?: string;
}

type Tab = 'rules' | 'tables' | 'source';

export function SkillDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [dir, setDir] = useState('');
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [active, setActive] = useState<SkillEntry | null>(null);
  const [raw, setRaw] = useState<string>('');
  const [tab, setTab] = useState<Tab>('rules');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const result = await window.kiroApi.skillList?.();
      setDir(result?.dir || '');
      setSkills(result?.skills || []);
      // Open the first one: with a single skill installed, making the user click once
      // more to see anything would be pure ceremony.
      if (result?.skills?.length) setActive(result.skills[0]);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!active?.ok) { setRaw(''); return; }
    void (async () => {
      const result = await window.kiroApi.skillRead?.(active.path);
      setRaw(result?.raw || '');
    })();
  }, [active]);

  const doc = active?.doc;
  const counts = useMemo(() => {
    if (!doc) return null;
    return {
      rules: doc.rules.length,
      pauses: doc.rules.filter((r) => r.interactive).length,
      writes: doc.rules.filter((r) => r.writes).length,
      tableRows: doc.tables.reduce((sum, tb) => sum + tb.rows.length, 0),
    };
  }, [doc]);

  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <div className="skill-dialog" role="dialog" aria-label={t('Skills')}>
        <div className="skill-dialog-head">
          <span className="skill-dialog-title">{t('🧩 Kiro skills')}</span>
          <span className="skill-dialog-sub">
            {loading ? t('Reading…') : active?.summary || (skills.length ? t('Pick a skill') : t('No skills found'))}
          </span>
          <button className="skill-dialog-close" onClick={onClose} aria-label={t('Close')}>✕</button>
        </div>

        <div className="skill-dialog-body">
          <div className="skill-side skill-side-left">
            <div className="skill-side-section">
              <div className="skill-side-head">{t('Installed ({n})', { n: skills.length })}</div>
              {!loading && skills.length === 0 && (
                <div className="skill-side-empty">
                  {withCode(t('No skill folders under {dir}.', { dir: SLOT }), <code>{dir || '~/.kiro/skills'}</code>)}
                </div>
              )}
              {skills.map((skill) => (
                <button
                  key={skill.path}
                  className={`skill-run${active?.path === skill.path ? ' selected' : ''}${skill.ok ? '' : ' waiting'}`}
                  onClick={() => { setActive(skill); setTab('rules'); }}
                >
                  <span className="skill-run-name">{skill.ok ? (skill.doc?.name || skill.folder) : `⚠ ${skill.folder}`}</span>
                  <span className="skill-run-summary">{skill.ok ? skill.summary : skill.error}</span>
                </button>
              ))}
            </div>
            <div className="skill-side-section skill-provenance">
              <div className="skill-side-head">{t('These files belong to kiro')}</div>
              <div className="skill-provenance-body">
                {t('Skills are loaded by ')}<b>{t('the model itself')}</b>{t(' based on the trigger conditions below. KiroLex does not invoke or modify these files; it only reads them to show you.')}
              </div>
            </div>
          </div>

          <div className="skill-main">
            {!doc && !loading && (
              <div className="skill-graph-empty">
                {t('Skills live in ')}<code>{t('~/.kiro/skills/<name>/SKILL.md')}</code>{t('.')}
                <br />{withCode(t('The {field} in the frontmatter is its trigger condition.', { field: SLOT }), <code>description</code>)}
              </div>
            )}
            {doc && (
              <>
                <div className="skill-trigger">
                  <div className="skill-trigger-label">{t('Trigger condition (the model uses this to decide whether to use the skill)')}</div>
                  <div className="skill-trigger-text">{doc.triggerText || doc.description || t('(no description in the frontmatter, so the model cannot tell when to use it)')}</div>
                </div>

                <div className="skill-tabs">
                  {([['rules', t('Rules {n}', { n: counts?.rules ?? 0 })], ['tables', t('Tables {n}', { n: doc.tables.length })], ['source', t('Source')]] as [Tab, string][])
                    .map(([id, label]) => (
                      <button key={id} className={`skill-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
                        {label}
                      </button>
                    ))}
                  <span className="skill-tabs-spacer" />
                  {counts!.pauses > 0 && <span className="skill-badge pause">{t('{n} need a human', { n: counts!.pauses })}</span>}
                  {counts!.writes > 0 && <span className="skill-badge write">{t('{n} write to external systems', { n: counts!.writes })}</span>}
                </div>

                {tab === 'rules' && (
                  <div className="skill-rules">
                    {doc.rules.length === 0 && <div className="skill-side-empty">{t('This skill has no numbered rules, only prose. See "Source".')}</div>}
                    {doc.rules.map((rule, index) => (
                      <div className={`skill-rule${rule.interactive ? ' interactive' : ''}${rule.writes ? ' writes' : ''}`} key={index}>
                        <span className="skill-rule-num">{rule.number}</span>
                        <div className="skill-rule-main">
                          <div className="skill-rule-label">
                            {rule.label}
                            {rule.interactive && <span className="skill-badge pause">{t('Needs a human')}</span>}
                            {rule.writes && <span className="skill-badge write">{t('Writes externally')}</span>}
                          </div>
                          <div className="skill-rule-text">{rule.text}</div>
                        </div>
                      </div>
                    ))}
                    {/* The real file numbers two rules 5 and skips 4. Shown, not fixed --
                        and explained, so it reads as a fact about the file rather than a
                        rendering bug. */}
                    {hasNumberingOddity(doc.rules) && (
                      <div className="skill-rules-note">
                        {t('Note: the numbering in the file has duplicates or gaps ({list}). It is shown as is; the panel does not renumber the file, or you could not tell the file itself has this problem.', { list: doc.rules.map((r) => r.number).join(', ') })}
                      </div>
                    )}
                  </div>
                )}

                {tab === 'tables' && (
                  <div className="skill-tables">
                    {doc.tables.length === 0 && <div className="skill-side-empty">{t('This skill has no tables.')}</div>}
                    {doc.tables.map((table, index) => (
                      <div className="skill-table-block" key={index}>
                        <div className="skill-table-caption">{table.section} · {t('{n} rows', { n: table.rows.length })}</div>
                        <div className="skill-table-scroll">
                          <table>
                            <thead>
                              <tr>{table.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
                            </thead>
                            <tbody>
                              {table.rows.map((row, r) => (
                                <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'source' && (
                  <div className="skill-source">
                    <div className="skill-source-path"><code>{active?.path}</code></div>
                    <pre>{raw || t('(loading…)')}</pre>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="skill-dialog-foot">
          {t('These rules are carried out by the model, ')}<b>{t('KiroLex does not enforce them')}</b>{t(': the model may skip any of them. "Writes externally" is a reminder, not a gate.')}
          {doc && <> {t('Sections: {list}', { list: doc.sections.map((s) => s.title).join(' · ') })}</>}
        </div>
      </div>
    </>,
    document.body,
  );
}

/** 把译文里 `SLOT` 那个位置换成一个元素（中英文里 <code> 的位置不一样，不能拆成前后两段）。 */
const SLOT = '\u0000';
function withCode(text: string, node: React.ReactNode): React.ReactNode {
  const at = text.indexOf(SLOT);
  return at < 0 ? text : <>{text.slice(0, at)}{node}{text.slice(at + SLOT.length)}</>;
}

/** Duplicated or non-monotonic numbering in the source file. */
function hasNumberingOddity(rules: SkillRule[]): boolean {
  for (let i = 1; i < rules.length; i++) {
    if (rules[i].number <= rules[i - 1].number) return true;
  }
  return false;
}

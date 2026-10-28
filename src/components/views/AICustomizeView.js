import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

export class AICustomizeView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            .unified-page {
                height: 100%;
            }
            .unified-wrap {
                height: 100%;
            }
            section.surface {
                flex: 1;
                display: flex;
                flex-direction: column;
            }
            .form-grid {
                flex: 1;
                display: flex;
                flex-direction: column;
            }
            .form-group.vertical {
                flex: 1;
                display: flex;
                flex-direction: column;
            }
            textarea.control {
                flex: 1;
                resize: none;
                overflow-y: auto;
                min-height: 0;
            }
            input.control {
                width: 100%;
            }
            .section-header {
                font-size: var(--font-size-sm);
                font-weight: 600;
                color: var(--accent);
                margin-top: var(--space-md);
                margin-bottom: var(--space-xs);
            }
        `,
    ];

    static properties = {
        selectedProfile: { type: String },
        onProfileChange: { type: Function },
        _context: { state: true },
        _targetRole: { state: true },
        _targetTechStack: { state: true },
        _jobDescription: { state: true },
    };

    constructor() {
        super();
        this.selectedProfile = 'interview';
        this.onProfileChange = () => {};
        this._context = '';
        this._targetRole = '';
        this._targetTechStack = '';
        this._jobDescription = '';
        this._loadFromStorage();
    }

    async _loadFromStorage() {
        try {
            const prefs = await cheatingDaddy.storage.getPreferences();
            this._context = prefs.customPrompt || '';
            this._targetRole = prefs.targetRole || '';
            this._targetTechStack = prefs.targetTechStack || '';
            this._jobDescription = prefs.jobDescription || '';
            this.requestUpdate();
        } catch (error) {
            console.error('Error loading AI customize storage:', error);
        }
    }

    _handleProfileChange(e) {
        this.onProfileChange(e.target.value);
    }

    async _saveContext(val) {
        this._context = val;
        await cheatingDaddy.storage.updatePreference('customPrompt', val);
    }

    async _saveTargetRole(val) {
        this._targetRole = val;
        await cheatingDaddy.storage.updatePreference('targetRole', val);
    }

    _handleRoleSelect(e) {
        const val = e.target.value;
        if (val === 'Custom') {
            this._saveTargetRole('Custom Role');
        } else {
            this._saveTargetRole(val);
        }
    }

    async _saveTargetTechStack(val) {
        this._targetTechStack = val;
        await cheatingDaddy.storage.updatePreference('targetTechStack', val);
    }

    async _saveJobDescription(val) {
        this._jobDescription = val;
        await cheatingDaddy.storage.updatePreference('jobDescription', val);
    }

    _getProfileName(profile) {
        const names = {
            interview: 'Job Interview',
            sales: 'Sales Call',
            meeting: 'Business Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
            exam: 'Exam Assistant',
        };
        return names[profile] || profile;
    }

    render() {
        const profiles = [
            { value: 'interview', label: 'Job Interview' },
            { value: 'sales', label: 'Sales Call' },
            { value: 'meeting', label: 'Business Meeting' },
            { value: 'presentation', label: 'Presentation' },
            { value: 'negotiation', label: 'Negotiation' },
            { value: 'exam', label: 'Exam Assistant' },
            { value: 'coding', label: 'Coding Challenge' },
        ];

        const standardRoles = [
            '',
            'Software Engineer',
            'Full-Stack Engineer',
            'Front-End Developer',
            'AI Engineer',
            'Machine Learning Engineer',
            'AI Automation Engineer',
        ];
        const isCustom = !standardRoles.includes(this._targetRole);
        const targetRoles = [
            { value: '', label: '-- Select Role --' },
            { value: 'Software Engineer', label: 'Software Engineer' },
            { value: 'Full-Stack Engineer', label: 'Full-Stack Engineer' },
            { value: 'Front-End Developer', label: 'Front-End Developer' },
            { value: 'AI Engineer', label: 'AI Engineer' },
            { value: 'Machine Learning Engineer', label: 'Machine Learning Engineer' },
            { value: 'AI Automation Engineer', label: 'AI Automation Engineer' },
            { value: 'Custom', label: 'Other / Custom Role...' },
        ];

        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div>
                        <div class="page-title">AI Context & Job Target</div>
                    </div>

                    <section class="surface">
                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label">Profile</label>
                                <select class="control" .value=${this.selectedProfile} @change=${this._handleProfileChange}>
                                    ${profiles.map(profile => html`<option value=${profile.value}>${profile.label}</option>`)}
                                </select>
                            </div>

                            ${this.selectedProfile === 'coding'
                                ? html`
                                      <div class="section-header">Coding Settings</div>
                                      <div class="form-group">
                                          <label class="form-label">Programming Language</label>
                                          <input
                                              type="text"
                                              class="control"
                                              placeholder="e.g. Python, JavaScript, C++ (Default is Python)"
                                              .value=${this._context}
                                              @input=${e => this._saveContext(e.target.value)}
                                          />
                                          <div class="form-help">Type the language you want the AI to write the solution in. Leave blank to default to Python.</div>
                                      </div>
                                  `
                                : html`
                                      <div class="section-header">Active Interview & Job Specification</div>

                                      <div class="form-group">
                                          <label class="form-label">Target Role / Job Title</label>
                                          <div style="display: flex; gap: 8px; flex: 1; align-items: center;">
                                              <select
                                                  class="control"
                                                  .value=${isCustom ? 'Custom' : this._targetRole}
                                                  @change=${e => this._handleRoleSelect(e)}
                                              >
                                                  ${targetRoles.map(r => html`<option value=${r.value}>${r.label}</option>`)}
                                              </select>
                                              ${
                                                  isCustom
                                                      ? html`
                                                            <input
                                                                type="text"
                                                                class="control"
                                                                placeholder="Type role title..."
                                                                .value=${this._targetRole === 'Custom Role' ? '' : this._targetRole}
                                                                @input=${e => this._saveTargetRole(e.target.value)}
                                                            />
                                                        `
                                                      : ''
                                              }
                                          </div>
                                      </div>

                                      <div class="form-group">
                                          <label class="form-label">Required Tech Stack / Keywords</label>
                                          <input
                                              type="text"
                                              class="control"
                                              placeholder="e.g. Golang, Kubernetes, React, Python, PostgreSQL, AWS"
                                              .value=${this._targetTechStack}
                                              @input=${e => this._saveTargetTechStack(e.target.value)}
                                          />
                                      </div>

                                      <div class="form-group vertical" style="flex: 0 0 100px;">
                                          <label class="form-label">Job Description / Key Requirements</label>
                                          <textarea
                                              class="control"
                                              placeholder="Paste the top 3-4 bullet points or responsibilities from the job posting here..."
                                              .value=${this._jobDescription}
                                              @input=${e => this._saveJobDescription(e.target.value)}
                                          ></textarea>
                                      </div>

                                      <div class="section-header">Master Resume & Background Context</div>

                                      <div class="form-group vertical">
                                          <label class="form-label">Master Resume (Permanent)</label>
                                          <textarea
                                              class="control"
                                              placeholder="Paste your complete master resume here once. The AI will strictly filter and match your experience against the Target Role and Tech Stack above during your call."
                                              .value=${this._context}
                                              @input=${e => this._saveContext(e.target.value)}
                                          ></textarea>
                                          <div class="form-help">Sent with your target role specifications at session start.</div>
                                      </div>
                                  `}
                        </div>
                    </section>
                </div>
            </div>
        `;
    }
}

customElements.define('ai-customize-view', AICustomizeView);

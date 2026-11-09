<script lang="ts">
  /**
   * TournamentScoreValidator - ValidatedBlocks in action
   * Use case: validating scores in gaming tournaments
   */
  
  import { getValidationEngine, required, range, math } from '@intijs/core/validation';
  import type { ValidationSummary, VisualValidationConfig } from '@intijs/core/validation';
  
  // Props
  export let matchId: string;
  export let player1Name: string = 'Player 1';
  export let player2Name: string = 'Player 2';
  
  // Form state
  let values = {
    player1Score: 0,
    player2Score: 0,
    totalScore: 0
  };
  
  // Validation state
  let validationState: ValidationSummary | null = null;
  let isValidating = false;
  
  // Visual validation config
  const validationConfig: VisualValidationConfig = {
    fields: {
      player1Score: [
        required('Player 1 score is required'),
        range(0, 100, 'Score must be between 0 and 100')
      ],
      player2Score: [
        required('Player 2 score is required'),
        range(0, 100, 'Score must be between 0 and 100')
      ],
      totalScore: [
        required('Total score is required'),
        range(0, 200, 'Total must be between 0 and 200')
      ]
    },
    blockRules: [
      math(
        'player1Score + player2Score === totalScore',
        '⚠️ The two scores must add up to the total'
      )
    ],
    visualInputs: {
      player1Score: {
        inputType: 'number',
        label: `Score: ${player1Name}`,
        placeholder: '0',
        description: 'Enter player 1 score',
        suffix: 'pts',
        step: 1
      },
      player2Score: {
        inputType: 'number',
        label: `Score: ${player2Name}`,
        placeholder: '0',
        description: 'Enter player 2 score',
        suffix: 'pts',
        step: 1
      },
      totalScore: {
        inputType: 'number',
        label: 'Total Score',
        placeholder: '0',
        description: 'Sum of both scores',
        suffix: 'pts',
        step: 1
      }
    },
    visualOutputs: {
      errorDisplay: 'below',
      warningDisplay: 'below',
      animations: {
        shakeOnError: true,
        pulseOnSuccess: true
      }
    },
    layout: {
      columns: 3,
      gap: 'medium',
      direction: 'horizontal'
    },
    showSummary: true,
    showProgress: true
  };
  
  // Validation engine
  const engine = getValidationEngine();
  
  // Validate in real time
  async function validate() {
    isValidating = true;
    validationState = await engine.validateBlock(validationConfig, values);
    isValidating = false;
  }
  
  // Validate whenever any value changes
  $: if (values) {
    validate();
  }
  
  // Compute the total automatically (optional)
  function autoCalculateTotal() {
    values.totalScore = values.player1Score + values.player2Score;
  }
  
  // Submit the result
  async function handleSubmit() {
    await validate();
    
    if (validationState?.valid) {
      // Send to the server
      const response = await fetch(`/api/matches/${matchId}/scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      
      if (response.ok) {
        alert('✅ Scores saved');
      } else {
        alert('❌ Error while saving');
      }
    } else {
      // Scroll to the first error
      const firstError = document.querySelector('.inti-input-error');
      firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  
  // Get state classes for inputs
  function getInputClass(fieldName: string): string {
    if (!validationState) return '';
    
    const fieldResults = validationState.results.filter(r => r.field === fieldName);
    if (fieldResults.length === 0) return '';
    
    const hasError = fieldResults.some(r => !r.valid && r.severity === 'error');
    const hasWarning = fieldResults.some(r => !r.valid && r.severity === 'warning');
    const isValid = fieldResults.every(r => r.valid);
    
    if (hasError) return 'input-error';
    if (hasWarning) return 'input-warning';
    if (isValid) return 'input-success';
    return '';
  }
  
  // Get the messages for a field
  function getFieldMessages(fieldName: string) {
    if (!validationState) return [];
    return validationState.results.filter(r => r.field === fieldName && !r.valid);
  }
</script>

<div class="tournament-validator">
  <header class="validator-header">
    <h3>Match Validation</h3>
    <span class="match-id">ID: {matchId}</span>
  </header>
  
  <!-- Progress bar -->
  {#if validationState}
    <div class="progress-bar-container">
      <div class="progress-bar">
        <div 
          class="progress-fill {validationState.valid ? 'valid' : ''}"
          style="width: {Math.round((validationState.results.filter(r => r.valid).length / validationState.results.length) * 100) || 0}%"
        />
      </div>
      <span class="progress-text">
        {validationState.results.filter(r => r.valid).length}/{validationState.results.length} validations
      </span>
    </div>
  {/if}
  
  <!-- Form -->
  <form class="validator-form" on:submit|preventDefault={handleSubmit}>
    <div class="form-grid">
      <!-- Player 1 -->
      <div class="field-group {getInputClass('player1Score')}">
        <label for="p1-score">
          {player1Name}
          <span class="required">*</span>
        </label>
        <div class="input-wrapper">
          <input
            id="p1-score"
            type="number"
            bind:value={values.player1Score}
            min="0"
            max="100"
            step="1"
            class={getInputClass('player1Score')}
            placeholder="0"
          />
          <span class="suffix">pts</span>
        </div>
        <p class="field-help">Maximum 100 points</p>
        {#each getFieldMessages('player1Score') as msg}
          <p class="message {msg.severity}">{msg.message}</p>
        {/each}
      </div>
      
      <!-- Player 2 -->
      <div class="field-group {getInputClass('player2Score')}">
        <label for="p2-score">
          {player2Name}
          <span class="required">*</span>
        </label>
        <div class="input-wrapper">
          <input
            id="p2-score"
            type="number"
            bind:value={values.player2Score}
            min="0"
            max="100"
            step="1"
            class={getInputClass('player2Score')}
            placeholder="0"
          />
          <span class="suffix">pts</span>
        </div>
        <p class="field-help">Maximum 100 points</p>
        {#each getFieldMessages('player2Score') as msg}
          <p class="message {msg.severity}">{msg.message}</p>
        {/each}
      </div>
      
      <!-- Total -->
      <div class="field-group {getInputClass('totalScore')}">
        <label for="total-score">
          Total
          <span class="required">*</span>
        </label>
        <div class="input-wrapper">
          <input
            id="total-score"
            type="number"
            bind:value={values.totalScore}
            min="0"
            max="200"
            step="1"
            class={getInputClass('totalScore')}
            placeholder="0"
          />
          <span class="suffix">pts</span>
        </div>
        <button type="button" class="auto-calc" on:click={autoCalculateTotal}>
          🧮 Auto-calculate
        </button>
        {#each getFieldMessages('totalScore') as msg}
          <p class="message {msg.severity}">{msg.message}</p>
        {/each}
      </div>
    </div>
    
    <!-- Cross validation -->
    {#if validationState?.blockRules && validationState.blockRules.length > 0}
      <div class="cross-validation">
        {#each validationState.results.filter(r => r.field === '__block__' && !r.valid) as msg}
          <div class="block-message {msg.severity}">
            <span class="icon">⚠️</span>
            {msg.message}
          </div>
        {/each}
      </div>
    {/if}
    
    <!-- Summary -->
    {#if validationState}
      <div class="validation-summary">
        {#if validationState.valid}
          <div class="summary-success">
            ✅ All values are valid. Ready to save.
          </div>
        {:else}
          <div class="summary-errors">
            <strong>❌ {validationState.errors.length} error(s):</strong>
            <ul>
              {#each validationState.errors as error}
                <li>{error.message}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    {/if}
    
    <!-- Actions -->
    <div class="form-actions">
      <button 
        type="submit" 
        class="btn-primary"
        disabled={!validationState?.valid || isValidating}
      >
        {isValidating ? 'Validating...' : '💾 Save Scores'}
      </button>
      <button type="button" class="btn-secondary" on:click={() => values = { player1Score: 0, player2Score: 0, totalScore: 0 }}>
        🔄 Reset
      </button>
    </div>
  </form>
</div>

<style>
  .tournament-validator {
    background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
    border-radius: 12px;
    padding: 1.5rem;
    color: #e2e8f0;
    max-width: 800px;
    margin: 0 auto;
  }
  
  .validator-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid #334155;
  }
  
  .validator-header h3 {
    margin: 0;
    font-size: 1.25rem;
    color: #f8fafc;
  }
  
  .match-id {
    font-size: 0.75rem;
    color: #64748b;
    font-family: monospace;
  }
  
  /* Progress bar */
  .progress-bar-container {
    margin-bottom: 1.5rem;
  }
  
  .progress-bar {
    height: 8px;
    background: #334155;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }
  
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #3b82f6, #8b5cf6);
    border-radius: 4px;
    transition: width 0.3s ease, background 0.3s ease;
  }
  
  .progress-fill.valid {
    background: linear-gradient(90deg, #10b981, #059669);
  }
  
  .progress-text {
    font-size: 0.75rem;
    color: #94a3b8;
  }
  
  /* Form grid */
  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  
  .field-group {
    display: flex;
    flex-direction: column;
  }
  
  .field-group label {
    font-size: 0.875rem;
    font-weight: 500;
    margin-bottom: 0.5rem;
    color: #cbd5e1;
  }
  
  .required {
    color: #ef4444;
    margin-left: 0.25rem;
  }
  
  .input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }
  
  .input-wrapper input {
    flex: 1;
    padding: 0.625rem 0.75rem;
    background: #1e293b;
    border: 2px solid #475569;
    border-radius: 6px;
    color: #f1f5f9;
    font-size: 1rem;
    transition: all 0.2s;
    width: 100%;
  }
  
  .input-wrapper input:focus {
    outline: none;
    border-color: #3b82f6;
  }
  
  .input-wrapper input.input-error {
    border-color: #ef4444;
    background: #fef2f2;
    color: #991b1b;
  }
  
  .input-wrapper input.input-warning {
    border-color: #f59e0b;
    background: #fffbeb;
    color: #92400e;
  }
  
  .input-wrapper input.input-success {
    border-color: #10b981;
    background: #f0fdf4;
    color: #166534;
  }
  
  .suffix {
    position: absolute;
    right: 0.75rem;
    color: #64748b;
    font-size: 0.875rem;
    pointer-events: none;
  }
  
  .field-help {
    font-size: 0.75rem;
    color: #64748b;
    margin: 0.375rem 0 0 0;
  }
  
  .auto-calc {
    margin-top: 0.5rem;
    padding: 0.375rem 0.75rem;
    background: #334155;
    border: 1px solid #475569;
    border-radius: 4px;
    color: #e2e8f0;
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.2s;
    align-self: flex-start;
  }
  
  .auto-calc:hover {
    background: #475569;
  }
  
  /* Messages */
  .message {
    margin: 0.375rem 0 0 0;
    font-size: 0.75rem;
    font-weight: 500;
  }
  
  .message.error {
    color: #ef4444;
  }
  
  .message.warning {
    color: #f59e0b;
  }
  
  .message.info {
    color: #3b82f6;
  }
  
  /* Cross validation */
  .cross-validation {
    margin-bottom: 1rem;
  }
  
  .block-message {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 6px;
    font-size: 0.875rem;
  }
  
  .block-message.error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #fca5a5;
  }
  
  .block-message.warning {
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: #fcd34d;
  }
  
  /* Summary */
  .validation-summary {
    margin-bottom: 1.5rem;
  }
  
  .summary-success {
    padding: 0.75rem;
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.3);
    border-radius: 6px;
    color: #6ee7b7;
    font-size: 0.875rem;
  }
  
  .summary-errors {
    padding: 0.75rem;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    color: #fca5a5;
  }
  
  .summary-errors ul {
    margin: 0.5rem 0 0 0;
    padding-left: 1.25rem;
    font-size: 0.875rem;
  }
  
  /* Actions */
  .form-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }
  
  .btn-primary {
    padding: 0.625rem 1.25rem;
    background: linear-gradient(135deg, #3b82f6, #8b5cf6);
    border: none;
    border-radius: 6px;
    color: white;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .btn-primary:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
  }
  
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .btn-secondary {
    padding: 0.625rem 1.25rem;
    background: transparent;
    border: 1px solid #475569;
    border-radius: 6px;
    color: #94a3b8;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .btn-secondary:hover {
    background: #334155;
    color: #e2e8f0;
  }
</style>

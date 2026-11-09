/**
 * FormEngine - schema-driven form engine
 * 
 * Handles:
 * - Form state
 * - Validation
 * - Submission
 * - Anti-spam
 */

import { getValidationEngine } from '../validation/engine.js';
import type { ValidationSummary, ValidationRule, BlockValidationConfig } from '../validation/types.js';
import type {
    FormSchema,
    FormField,
    FormState,
    FormSubmission,
    FormSubmissionResult,
    FormSubmissionConfig,
    SpamProtectionConfig,
    FormEngineConfig,
    FormEvent,
    FormEventHandler,
    FormEventType
} from './types.js';

// ============================================
// Main Engine
// ============================================

export class FormEngine {
    private config: FormEngineConfig;
    private eventHandlers: Map<FormEventType, FormEventHandler[]> = new Map();
    
    constructor(config: FormEngineConfig = {}) {
        this.config = {
            defaultMessages: {
                required: 'This field is required',
                invalid: 'The value entered is not valid',
                submitSuccess: 'Form submitted successfully',
                submitError: 'There was an error submitting the form'
            },
            ...config
        };
    }
    
    /**
     * Create the form's initial state
     */
    createInitialState(schema: FormSchema): FormState {
        const values: Record<string, any> = {};
        
        // Set default values
        for (const field of schema.fields) {
            if (field.defaultValue !== undefined) {
                values[field.name] = field.defaultValue;
            } else {
                // Default values by type
                switch (field.type) {
                    case 'checkbox':
                    case 'multiselect':
                        values[field.name] = [];
                        break;
                    case 'number':
                    case 'slider':
                    case 'rating':
                        values[field.name] = null;
                        break;
                    case 'switch':
                        values[field.name] = false;
                        break;
                    default:
                        values[field.name] = '';
                }
            }
        }
        
        return {
            values,
            errors: {},
            touched: {},
            dirty: {},
            validation: null,
            currentStep: schema.steps ? 0 : undefined,
            isSubmitting: false,
            isValid: false,
            isSuccess: false
        };
    }
    
    /**
     * Validate a single field
     */
    async validateField(
        field: FormField,
        value: any,
        allValues: Record<string, any>
    ): Promise<string | null> {
        const rules = field.validation || [];
        
        // Add the required rule if it applies
        if (field.required && !rules.some(r => r.type === 'required')) {
            rules.unshift({
                type: 'required',
                message: this.config.defaultMessages?.required || 'Required field'
            });
        }
        
        if (rules.length === 0) return null;
        
        const engine = getValidationEngine();
        const context = {
            value,
            allValues,
            fieldName: field.name,
            fieldPath: field.name
        };
        
        for (const rule of rules) {
            const result = await engine.validateField(rule, context);
            if (!result.valid) {
                return result.message;
            }
        }
        
        return null;
    }
    
    /**
     * Validate the whole form
     */
    async validateForm(schema: FormSchema, values: Record<string, any>): Promise<ValidationSummary> {
        const engine = getValidationEngine();
        
        // Prepare rules per field
        const fieldRules: Record<string, ValidationRule[]> = {};
        
        for (const field of schema.fields) {
            const rules = [...(field.validation || [])];
            
            if (field.required && !rules.some(r => r.type === 'required')) {
                rules.unshift({
                    type: 'required',
                    message: this.config.defaultMessages?.required || 'Required field'
                });
            }
            
            fieldRules[field.name] = rules;
        }
        
        const config: BlockValidationConfig = {
            fields: fieldRules,
            validateOn: ['submit']
        };
        
        return engine.validateBlock(config, values);
    }
    
    /**
     * Evaluate a field's visibility conditions
     */
    evaluateConditions(field: FormField, values: Record<string, any>): boolean {
        if (!field.conditions || field.conditions.length === 0) {
            return true; // Always visible if there are no conditions
        }
        
        for (const condition of field.conditions) {
            const fieldValue = values[condition.field];
            let conditionMet = false;
            
            switch (condition.operator) {
                case 'eq':
                    conditionMet = fieldValue === condition.value;
                    break;
                case 'neq':
                    conditionMet = fieldValue !== condition.value;
                    break;
                case 'contains':
                    conditionMet = Array.isArray(fieldValue) 
                        ? fieldValue.includes(condition.value)
                        : String(fieldValue).includes(String(condition.value));
                    break;
                case 'gt':
                    conditionMet = Number(fieldValue) > Number(condition.value);
                    break;
                case 'gte':
                    conditionMet = Number(fieldValue) >= Number(condition.value);
                    break;
                case 'lt':
                    conditionMet = Number(fieldValue) < Number(condition.value);
                    break;
                case 'lte':
                    conditionMet = Number(fieldValue) <= Number(condition.value);
                    break;
                case 'empty':
                    conditionMet = !fieldValue || 
                        (Array.isArray(fieldValue) && fieldValue.length === 0) ||
                        (typeof fieldValue === 'string' && fieldValue.trim() === '');
                    break;
                case 'notEmpty':
                    conditionMet = !!fieldValue && 
                        (!Array.isArray(fieldValue) || fieldValue.length > 0) &&
                        (typeof fieldValue !== 'string' || fieldValue.trim() !== '');
                    break;
            }
            
            // If the condition is not met and the action is 'show', hide
            if (!conditionMet && condition.action === 'show') return false;
            // If the condition is met and the action is 'hide', hide
            if (conditionMet && condition.action === 'hide') return false;
        }
        
        return true;
    }
    
    /**
     * Check anti-spam protection
     */
    validateSpamProtection(
        config: SpamProtectionConfig,
        submission: FormSubmission,
        formStartTime?: number
    ): { valid: boolean; error?: string } {
        // Honeypot check
        if (config.honeypot && config.honeypotField) {
            const honeypotValue = submission.data[config.honeypotField];
            if (honeypotValue) {
                return { valid: false, error: 'Spam detected' };
            }
        }
        
        // Min time check (anti-bot)
        if (config.minTime && formStartTime) {
            const elapsed = Date.now() - formStartTime;
            if (elapsed < config.minTime) {
                return { valid: false, error: 'Form submitted too quickly' };
            }
        }
        
        // Rate limiting (simplified - in production use Redis/cache)
        if (config.rateLimit) {
            // Basic implementation - in production use persistent storage
            console.warn('Rate limiting should be implemented with persistent storage');
        }
        
        return { valid: true };
    }
    
    /**
     * Form submit
     */
    async submit(
        schema: FormSchema,
        submission: FormSubmission,
        formStartTime?: number
    ): Promise<FormSubmissionResult> {
        // 1. Validate
        const validation = await this.validateForm(schema, submission.data);
        
        if (!validation.valid) {
            return {
                success: false,
                message: schema.submission?.errorMessage || this.config.defaultMessages?.submitError || 'Validation error',
                errors: validation.errors.map(e => ({
                    field: e.field || 'unknown',
                    message: e.message
                }))
            };
        }
        
        // 2. Anti-spam
        const spamConfig = schema.spamProtection || this.config.defaultSpamProtection;
        if (spamConfig) {
            const spamCheck = this.validateSpamProtection(spamConfig, submission, formStartTime);
            if (!spamCheck.valid) {
                return {
                    success: false,
                    message: 'Spam protection triggered',
                    errors: [{ field: 'spam', message: spamCheck.error || 'Invalid submission' }]
                };
            }
        }
        
        // 3. Run the submission
        const submissionConfig = schema.submission || this.config.defaultSubmission;
        
        if (!submissionConfig) {
            return {
                success: false,
                message: 'No submission handler configured'
            };
        }
        
        try {
            const result = await this.executeSubmission(submissionConfig, submission);
            return result;
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : 'Submission failed'
            };
        }
    }
    
    /**
     * Run the submission handler
     */
    private async executeSubmission(
        config: FormSubmissionConfig,
        submission: FormSubmission
    ): Promise<FormSubmissionResult> {
        // Multiple handlers
        if (config.handlers && config.handlers.length > 0) {
            for (const handler of config.handlers) {
                const result = await this.executeSingleSubmission(handler, submission);
                if (!result.success) return result;
            }
            return {
                success: true,
                message: config.successMessage || this.config.defaultMessages?.submitSuccess || 'Success'
            };
        }
        
        // Single handler
        return this.executeSingleSubmission(config, submission);
    }
    
    private async executeSingleSubmission(
        config: FormSubmissionConfig,
        submission: FormSubmission
    ): Promise<FormSubmissionResult> {
        switch (config.type) {
            case 'webhook':
                return this.submitToWebhook(config, submission);
                
            case 'email':
                // Email handling - integrate with an email service
                console.warn('Email submission not implemented in core');
                return { success: true, message: 'Email sent' };
                
            case 'cms':
                // CMS submission - depends on the adapter
                console.warn('CMS submission not implemented in core');
                return { success: true, message: 'Saved to CMS' };
                
            case 'function':
                // Serverless function
                return this.submitToFunction(config, submission);
                
            case 'custom':
                // Registered custom handler
                console.warn('Custom handlers should be implemented per-project');
                return { success: true, message: 'Custom handler executed' };
                
            default:
                return { success: false, message: 'Unknown submission type' };
        }
    }
    
    private async submitToWebhook(
        config: FormSubmissionConfig,
        submission: FormSubmission
    ): Promise<FormSubmissionResult> {
        const response = await fetch(config.destination, {
            method: config.method || 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...config.headers
            },
            body: JSON.stringify(submission)
        });
        
        if (!response.ok) {
            return {
                success: false,
                message: `Webhook error: ${response.status} ${response.statusText}`
            };
        }
        
        const data = await response.json().catch(() => null);
        
        return {
            success: true,
            message: config.successMessage || this.config.defaultMessages?.submitSuccess || 'Submitted successfully',
            data,
            redirect: config.redirect?.url
        };
    }
    
    private async submitToFunction(
        config: FormSubmissionConfig,
        submission: FormSubmission
    ): Promise<FormSubmissionResult> {
        // Like a webhook but for serverless functions
        const response = await fetch(config.destination, {
            method: config.method || 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...config.headers
            },
            body: JSON.stringify(submission)
        });
        
        const result = await response.json();
        
        return {
            success: response.ok && result.success !== false,
            message: result.message || (response.ok ? 'Success' : 'Error'),
            data: result,
            redirect: result.redirect || config.redirect?.url
        };
    }
    
    /**
     * Register an event handler
     */
    on(event: FormEventType, handler: FormEventHandler): void {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event)!.push(handler);
    }
    
    /**
     * Emit an event
     */
    async emit(event: FormEvent, state: FormState): Promise<void> {
        const handlers = this.eventHandlers.get(event.type) || [];
        for (const handler of handlers) {
            await handler(event, state);
        }
    }
    
    /**
     * Get the fields visible under the conditions
     */
    getVisibleFields(schema: FormSchema, values: Record<string, any>): FormField[] {
        return schema.fields.filter(field => this.evaluateConditions(field, values));
    }
    
    /**
     * Change step (multi-step forms)
     */
    async changeStep(
        schema: FormSchema,
        currentState: FormState,
        newStep: number
    ): Promise<{ valid: boolean; state: FormState; error?: string }> {
        if (!schema.steps || newStep < 0 || newStep >= schema.steps.length) {
            return { valid: false, state: currentState, error: 'Invalid step' };
        }
        
        // Validate the current step if needed
        if (schema.steps[currentState.currentStep!]?.validateOnNext) {
            const stepFieldNames = schema.steps[currentState.currentStep!].fields;
            const stepValues: Record<string, any> = {};
            
            for (const fieldName of stepFieldNames) {
                stepValues[fieldName] = currentState.values[fieldName];
            }
            
            const validation = await this.validateForm(schema, currentState.values);
            
            if (!validation.valid) {
                return { valid: false, state: currentState, error: 'Validation failed' };
            }
        }
        
        return {
            valid: true,
            state: {
                ...currentState,
                currentStep: newStep
            }
        };
    }
}

// ============================================
// Global Instance
// ============================================

let globalFormEngine: FormEngine | null = null;

export function getFormEngine(config?: FormEngineConfig): FormEngine {
    if (!globalFormEngine) {
        globalFormEngine = new FormEngine(config);
    }
    return globalFormEngine;
}

export function createFormEngine(config?: FormEngineConfig): FormEngine {
    return new FormEngine(config);
}

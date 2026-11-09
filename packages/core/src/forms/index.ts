/**
 * FormEngine - schema-driven form system for Inti.js
 */

// Types
export type {
    // Schema
    FormFieldType,
    FormFieldOption,
    FormField,
    FieldCondition,
    FormStep,
    FormSchema,
    // Submission
    SubmissionHandlerType,
    FormSubmissionConfig,
    // Anti-spam
    SpamProtectionConfig,
    // State
    FormState,
    FormSubmission,
    FormSubmissionResult,
    // Configuration
    FormEngineConfig,
    // Events
    FormEventType,
    FormEvent,
    FormEventHandler
} from './types.js';

// Engine
export { 
    FormEngine,
    getFormEngine,
    createFormEngine 
} from './engine.js';

// Helpers to create schemas
export function createFormField(
    id: string,
    name: string,
    type: FormFieldType,
    label: string,
    options: Partial<Omit<FormField, 'id' | 'name' | 'type' | 'label'>> = {}
): FormField {
    return {
        id,
        name,
        type,
        label,
        ...options
    };
}

export function createFormSchema(
    id: string,
    name: string,
    fields: FormField[],
    options: Partial<Omit<FormSchema, 'id' | 'name' | 'fields'>> = {}
): FormSchema {
    return {
        id,
        name,
        fields,
        ...options
    };
}

// Import types for the helpers
import type { FormField, FormFieldType, FormSchema } from './types.js';

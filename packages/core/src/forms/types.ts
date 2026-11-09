/**
 * FormEngine - schema-driven form system for Inti.js
 * 
 * Features:
 * - Forms defined from the CMS
 * - Automatic schema-based validation
 * - Universal submission handlers
 * - Anti-spam protection
 */

import type { 
    ValidationRule, 
    ValidationInputConfig,
    ValidationOutputConfig,
    ValidationSummary 
} from '../validation/types.js';

// ============================================
// Form Schema
// ============================================

export type FormFieldType = 
    | 'text'
    | 'email'
    | 'tel'
    | 'url'
    | 'password'
    | 'number'
    | 'date'
    | 'datetime'
    | 'time'
    | 'textarea'
    | 'select'
    | 'multiselect'
    | 'checkbox'
    | 'radio'
    | 'switch'
    | 'slider'
    | 'rating'
    | 'file'
    | 'image'
    | 'hidden'
    | 'custom';

export interface FormFieldOption {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
    icon?: string;
}

export interface FormField {
    /** Unique field ID */
    id: string;
    /** Field name (for the form data) */
    name: string;
    /** Field type */
    type: FormFieldType;
    /** Visible label */
    label: string;
    /** Placeholder */
    placeholder?: string;
    /** Description/help */
    description?: string;
    /** Default value */
    defaultValue?: any;
    /** Whether it is required */
    required?: boolean;
    /** Whether it is disabled */
    disabled?: boolean;
    /** Whether it is read-only */
    readonly?: boolean;
    /** Validation rules */
    validation?: ValidationRule[];
    /** Options for select/checkbox/radio */
    options?: FormFieldOption[];
    /** Visual configuration */
    visual?: ValidationInputConfig;
    /** Visibility conditions */
    conditions?: FieldCondition[];
    /** Field width (1-12) */
    width?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
    /** Order in the form */
    order?: number;
}

export interface FieldCondition {
    /** Field to evaluate */
    field: string;
    /** Operator */
    operator: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'empty' | 'notEmpty';
    /** Value to compare */
    value?: any;
    /** Action: show or hide */
    action: 'show' | 'hide';
}

export interface FormStep {
    /** Step ID */
    id: string;
    /** Step title */
    title: string;
    /** Description */
    description?: string;
    /** Fields in this step */
    fields: string[]; // Field IDs
    /** Validate when changing step */
    validateOnNext?: boolean;
}

export interface FormSchema {
    /** Unique form ID */
    id: string;
    /** Form name */
    name: string;
    /** Description */
    description?: string;
    /** Form fields */
    fields: FormField[];
    /** Steps (if multi-step) */
    steps?: FormStep[];
    /** Visual validation configuration */
    visualOutput?: ValidationOutputConfig;
    /** Layout configuration */
    layout?: {
        columns?: 1 | 2 | 3 | 4;
        gap?: 'small' | 'medium' | 'large';
    };
    /** Show a progress bar */
    showProgress?: boolean;
    /** Submit button text */
    submitLabel?: string;
    /** Reset button text */
    resetLabel?: string;
    /** Submission handler */
    submission?: FormSubmissionConfig;
    /** Anti-spam */
    spamProtection?: SpamProtectionConfig;
}

// ============================================
// Submission Configuration
// ============================================

export type SubmissionHandlerType = 
    | 'webhook'
    | 'email'
    | 'cms'
    | 'database'
    | 'function'
    | 'custom';

export interface FormSubmissionConfig {
    /** Handler type */
    type: SubmissionHandlerType;
    /** Endpoint/destination */
    destination: string;
    /** HTTP method (for webhook) */
    method?: 'POST' | 'PUT' | 'PATCH';
    /** Extra headers */
    headers?: Record<string, string>;
    /** Transform the data before sending */
    transform?: string; // Name of a registered function
    /** Success message */
    successMessage?: string;
    /** Error message */
    errorMessage?: string;
    /** Redirect after success */
    redirect?: {
        url: string;
        delay?: number; // ms
    };
    /** Multiple handlers */
    handlers?: FormSubmissionConfig[];
}

// ============================================
// Anti-Spam
// ============================================

export interface SpamProtectionConfig {
    /** Honeypot field */
    honeypot?: boolean;
    /** Honeypot field name */
    honeypotField?: string;
    /** Rate limiting */
    rateLimit?: {
        maxRequests: number;
        windowMs: number;
    };
    /** reCAPTCHA / hCaptcha */
    captcha?: {
        provider: 'recaptcha' | 'hcaptcha' | 'turnstile';
        siteKey: string;
        secretKey?: string;
        action?: string;
    };
    /** Minimum time to complete the form (anti-bot) */
    minTime?: number; // ms
}

// ============================================
// Form State
// ============================================

export interface FormState {
    /** Current values */
    values: Record<string, any>;
    /** Validation errors */
    errors: Record<string, string>;
    /** Touched fields */
    touched: Record<string, boolean>;
    /** Modified fields */
    dirty: Record<string, boolean>;
    /** Validation state */
    validation: ValidationSummary | null;
    /** Current step (multi-step) */
    currentStep?: number;
    /** Whether it is submitting */
    isSubmitting: boolean;
    /** Whether it is valid */
    isValid: boolean;
    /** Whether it was submitted successfully */
    isSuccess: boolean;
    /** Submission error */
    submitError?: string;
}

// ============================================
// Submission and Response
// ============================================

export interface FormSubmission {
    /** Form ID */
    formId: string;
    /** Submitted data */
    data: Record<string, any>;
    /** Metadata */
    metadata: {
        timestamp: number;
        userAgent?: string;
        ip?: string;
        referrer?: string;
    };
    /** Uploaded files */
    files?: Array<{
        fieldName: string;
        fileName: string;
        mimeType: string;
        size: number;
        url?: string;
    }>;
}

export interface FormSubmissionResult {
    /** Whether it succeeded */
    success: boolean;
    /** Message */
    message: string;
    /** Response data */
    data?: any;
    /** Errors */
    errors?: Array<{
        field: string;
        message: string;
    }>;
    /** Redirect */
    redirect?: string;
}

// ============================================
// FormEngine Configuration
// ============================================

export interface FormEngineConfig {
    /** Default submission handler */
    defaultSubmission?: FormSubmissionConfig;
    /** Default spam protection */
    defaultSpamProtection?: SpamProtectionConfig;
    /** Registered custom validators */
    customValidators?: Record<string, (value: any, context: any) => boolean | Promise<boolean>>;
    /** Custom field components */
    customFields?: Record<string, any>;
    /** Default messages */
    defaultMessages?: {
        required?: string;
        invalid?: string;
        submitSuccess?: string;
        submitError?: string;
    };
}

// ============================================
// Form Events
// ============================================

export type FormEventType = 
    | 'init'
    | 'fieldChange'
    | 'fieldBlur'
    | 'validate'
    | 'stepChange'
    | 'submit'
    | 'submitSuccess'
    | 'submitError'
    | 'reset';

export interface FormEvent {
    type: FormEventType;
    formId: string;
    field?: string;
    value?: any;
    values?: Record<string, any>;
    timestamp: number;
}

export type FormEventHandler = (event: FormEvent, state: FormState) => void | Promise<void>;

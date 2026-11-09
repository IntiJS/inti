/**
 * ValidatedBlocks - Validation system for Inti blocks
 * Lets you define business rules declaratively and visually
 */

import type { IntiBlock } from '../types/index.js';

// ============================================
// Validation Rule Types
// ============================================

export type ValidationRuleType = 
    | 'math'           // Math expressions
    | 'regex'          // Text patterns
    | 'range'          // Numeric ranges
    | 'comparison'     // Comparisons (=, !=, <, >, <=, >=)
    | 'dependency'     // Dependencies between fields
    | 'custom'         // Custom function
    | 'required'       // Required field
    | 'type';          // Data type

export type ValidationSeverity = 'error' | 'warning' | 'info';

export type ValidationTrigger = 'input' | 'blur' | 'submit' | 'change';

// ============================================
// Rule Configuration
// ============================================

export interface BaseValidationRule {
    type: ValidationRuleType;
    message: string;
    severity?: ValidationSeverity;
    triggers?: ValidationTrigger[];
    /** If true, the validation also runs on the server */
    serverSide?: boolean;
}

export interface MathValidationRule extends BaseValidationRule {
    type: 'math';
    /** Math expression using the fields' variables */
    expression: string;
    /** Variables allowed in the expression */
    variables?: string[];
}

export interface RegexValidationRule extends BaseValidationRule {
    type: 'regex';
    pattern: string;
    flags?: string;
}

export interface RangeValidationRule extends BaseValidationRule {
    type: 'range';
    min?: number;
    max?: number;
    inclusive?: boolean;
}

export interface ComparisonValidationRule extends BaseValidationRule {
    type: 'comparison';
    operator: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
    field: string;
    value?: number | string | boolean;
}

export interface DependencyValidationRule extends BaseValidationRule {
    type: 'dependency';
    /** Fields that must be present for this field to be valid */
    dependsOn: string[];
    /** Condition that must be met */
    condition?: string;
}

export interface CustomValidationRule extends BaseValidationRule {
    type: 'custom';
    /** Validation function (only available at runtime, not in JSON) */
    validator?: (value: any, context: ValidationContext) => boolean | Promise<boolean>;
    /** Identifier for serializable rules */
    validatorId?: string;
}

export interface RequiredValidationRule extends BaseValidationRule {
    type: 'required';
    /** Allows empty values but not null/undefined */
    allowEmpty?: boolean;
}

export interface TypeValidationRule extends BaseValidationRule {
    type: 'type';
    expectedType: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'date';
}

export type ValidationRule =
    | MathValidationRule
    | RegexValidationRule
    | RangeValidationRule
    | ComparisonValidationRule
    | DependencyValidationRule
    | CustomValidationRule
    | RequiredValidationRule
    | TypeValidationRule;

// ============================================
// Context and Results
// ============================================

export interface ValidationContext {
    /** Value of the current field */
    value: any;
    /** All the form/block values */
    allValues: Record<string, any>;
    /** Name of the current field */
    fieldName: string;
    /** Full path (for nested fields) */
    fieldPath: string;
    /** Additional metadata */
    metadata?: Record<string, any>;
}

export interface ValidationResult {
    /** Whether the validation passed */
    valid: boolean;
    /** Result severity */
    severity: ValidationSeverity;
    /** Error/warning message */
    message: string;
    /** Error identifier code */
    code?: string;
    /** Field it applies to */
    field?: string;
    /** Additional metadata */
    metadata?: Record<string, any>;
}

export interface ValidationSummary {
    /** Whether all the validations passed */
    valid: boolean;
    /** Individual results */
    results: ValidationResult[];
    /** Errors (severity = error) */
    errors: ValidationResult[];
    /** Warnings (severity = warning) */
    warnings: ValidationResult[];
    /** Info (severity = info) */
    infos: ValidationResult[];
    /** Validation timestamp */
    timestamp: number;
}

// ============================================
// Block Validation Configuration
// ============================================

export interface BlockValidationConfig {
    /** Rules per field */
    fields: Record<string, ValidationRule[]>;
    /** Block-level rules (cross-field) */
    blockRules?: ValidationRule[];
    /** When to run the validation */
    validateOn?: ValidationTrigger[];
    /** Validate on the server too */
    serverSide?: boolean;
}

export interface ValidatedBlock extends IntiBlock {
    /** Validation configuration */
    validation?: BlockValidationConfig;
    /** Current validation state */
    validationState?: ValidationSummary;
}

// ============================================
// Visual Configuration of Inputs/Outputs
// ============================================

export interface ValidationInputConfig {
    /** Visual input type */
    inputType: 
        | 'text' 
        | 'number' 
        | 'email' 
        | 'tel'
        | 'url'
        | 'date'
        | 'datetime-local'
        | 'textarea'
        | 'select'
        | 'checkbox'
        | 'radio'
        | 'slider'
        | 'rating'
        | 'currency'
        | 'percentage';
    
    /** Field label */
    label: string;
    
    /** Placeholder */
    placeholder?: string;
    
    /** Description/help text */
    description?: string;
    
    /** Icon (icon name or URL) */
    icon?: string;
    
    /** Valid example placeholder */
    example?: string;
    
    /** Prefix (e.g. $ for currency) */
    prefix?: string;
    
    /** Suffix (e.g. % for percentage) */
    suffix?: string;
    
    /** Step for numbers */
    step?: number;
    
    /** Allowed decimals */
    decimals?: number;
    
    /** Options for select/radio */
    options?: Array<{
        value: string | number;
        label: string;
        description?: string;
        disabled?: boolean;
    }>;
    
    /** Autocomplete */
    autocomplete?: string;
    
    /** Disabled */
    disabled?: boolean;
    
    /** Readonly */
    readonly?: boolean;
}

export interface ValidationOutputConfig {
    /** How to show errors */
    errorDisplay: 
        | 'tooltip'      // Floating tooltip
        | 'below'        // Text below the input
        | 'above'        // Text above
        | 'inline'       // Next to the input
        | 'toast'        // Toast notification
        | 'summary'      // Only in the summary
        | 'border';      // Red border only
    
    /** How to show warnings */
    warningDisplay?: 'tooltip' | 'below' | 'above' | 'inline' | 'toast' | 'summary';
    
    /** How to show info */
    infoDisplay?: 'tooltip' | 'below' | 'above' | 'inline' | 'toast' | 'summary';
    
    /** Custom CSS classes */
    classes?: {
        error?: string;
        warning?: string;
        info?: string;
        success?: string;
        input?: string;
    };
    
    /** Custom icons */
    icons?: {
        error?: string;
        warning?: string;
        info?: string;
        success?: string;
        valid?: string;
        invalid?: string;
    };
    
    /** Animations */
    animations?: {
        shakeOnError?: boolean;
        pulseOnSuccess?: boolean;
        fadeIn?: boolean;
    };
    
    /** Sounds (optional) */
    sounds?: {
        error?: string;
        success?: string;
    };
}

// ============================================
// Full Visual Validation Configuration
// ============================================

export interface VisualValidationConfig extends BlockValidationConfig {
    /** Visual configuration of each field */
    visualInputs: Record<string, ValidationInputConfig>;
    
    /** Outputs/feedback configuration */
    visualOutputs: ValidationOutputConfig;
    
    /** Form layout */
    layout?: {
        columns?: 1 | 2 | 3 | 4;
        gap?: 'small' | 'medium' | 'large';
        direction?: 'vertical' | 'horizontal';
    };
    
    /** Show the validation summary */
    showSummary?: boolean;
    
    /** Show the valid fields counter */
    showProgress?: boolean;
}

// ============================================
// Validation Schema (for CMS)
// ============================================

export interface ValidationSchemaField {
    name: string;
    label: string;
    type: ValidationInputConfig['inputType'];
    required?: boolean;
    rules: ValidationRule[];
    visual: ValidationInputConfig;
}

export interface ValidationSchema {
    name: string;
    description?: string;
    fields: ValidationSchemaField[];
    crossFieldRules?: ValidationRule[];
    output: ValidationOutputConfig;
}

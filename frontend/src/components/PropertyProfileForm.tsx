/**
 * PropertyProfileForm.tsx
 * Sprint 1 - Property Intelligence System
 * Location: frontend/src/components/PropertyProfileForm.tsx
 *
 * Comprehensive property detail form with:
 * - Property info capture
 * - Photo uploads
 * - Complexity scoring
 * - Time estimation
 */

import React, { useState, useEffect } from 'react';
import { MapPin, Upload, AlertCircle, TrendingUp, Clock, Loader } from 'lucide-react';

interface PropertyProfile {
  id?: string;
  client_id: string;
  address: string;
  city?: string;
  state?: string;
  zip_code?: string;
  lat?: number;
  lng?: number;
  property_type: 'residential' | 'commercial' | 'rental';
  square_footage?: number;
  bedrooms?: number;
  bathrooms?: number;
  construction_type?: string;
  access_type?: string;
  access_instructions?: string;
  hazard_notes?: string;
  pet_alerts?: string;
  equipment_required?: string[];
  avg_condition_rating?: number;
  condition_notes?: string;
}

interface TimeEstimate {
  estimated_minutes: number;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  sample_size: number;
}

interface PropertyProfileFormProps {
  clientId: string;
  onSave: (property: PropertyProfile) => void;
  initialData?: PropertyProfile;
}

export default function PropertyProfileForm({ clientId, onSave, initialData }: PropertyProfileFormProps) {
  const [formData, setFormData] = useState<PropertyProfile>(
    initialData || {
      client_id: clientId,
      address: '',
      property_type: 'residential',
      equipment_required: [],
    }
  );

  const [complexityScore, setComplexityScore] = useState<number | null>(null);
  const [timeEstimate, setTimeEstimate] = useState<TimeEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoPreview, setPhotoPreview] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Calculate complexity score in real-time
  useEffect(() => {
    if (formData.property_type && formData.square_footage) {
      let score = 1;

      // Property type
      if (formData.property_type === 'rental') score += 3;
      else if (formData.property_type === 'commercial') score += 2;

      // Size
      if (formData.square_footage > 5000) score += 3;
      else if (formData.square_footage > 3000) score += 2;
      else if (formData.square_footage > 1500) score += 1;

      // Condition
      if (formData.avg_condition_rating && formData.avg_condition_rating < 2) score += 3;
      else if (formData.avg_condition_rating && formData.avg_condition_rating < 3) score += 2;

      // Hazards
      if (formData.hazard_notes) score += 1;
      if (formData.pet_alerts) score += 1;

      setComplexityScore(Math.min(score, 10));
    }
  }, [formData.property_type, formData.square_footage, formData.avg_condition_rating, formData.hazard_notes, formData.pet_alerts]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    const numFields = ['square_footage', 'bedrooms', 'bathrooms'];

    setFormData({
      ...formData,
      [name]: numFields.includes(name) ? parseInt(value) || undefined : value,
    });
  };

  const handleEquipmentToggle = (equipment: string) => {
    setFormData({
      ...formData,
      equipment_required: formData.equipment_required?.includes(equipment)
        ? formData.equipment_required.filter(e => e !== equipment)
        : [...(formData.equipment_required || []), equipment],
    });
  };

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;

    const files = Array.from(e.target.files);
    setPhotos([...photos, ...files]);

    // Generate previews
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        setPhotoPreview(prev => [...prev, event.target?.result as string]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrors({});

    try {
      // Validate required fields
      if (!formData.address) {
        setErrors({ address: 'Address is required' });
        return;
      }

      // Save property
      const response = await fetch('/api/properties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) throw new Error('Failed to save property');

      const savedProperty = await response.json();

      // Upload photos if any
      if (photos.length > 0) {
        for (const photo of photos) {
          const photoFormData = new FormData();
          photoFormData.append('file', photo);
          photoFormData.append('photo_type', 'reference');

          await fetch(`/api/properties/${savedProperty.id}/upload-photo`, {
            method: 'POST',
            body: photoFormData,
          });
        }
      }

      onSave(savedProperty);
    } catch (error) {
      setErrors({ submit: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` });
    } finally {
      setLoading(false);
    }
  };

  const estimateTime = async () => {
    if (!formData.id) return;

    try {
      const response = await fetch(`/api/properties/${formData.id}/estimate-time`);
      if (!response.ok) throw new Error('Failed to get time estimate');
      const data = await response.json();
      setTimeEstimate(data);
    } catch (error) {
      setErrors({ ...errors, timeEstimate: 'Failed to estimate time' });
    }
  };

  const getConditionColor = (rating?: number) => {
    if (!rating) return 'bg-gray-100';
    if (rating <= 2) return 'bg-red-100 border-red-300';
    if (rating <= 3) return 'bg-yellow-100 border-yellow-300';
    return 'bg-green-100 border-green-300';
  };

  const getComplexityColor = (score?: number) => {
    if (!score) return 'bg-gray-100';
    if (score <= 3) return 'bg-green-100 text-green-900';
    if (score <= 6) return 'bg-yellow-100 text-yellow-900';
    return 'bg-red-100 text-red-900';
  };

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <h2 className="text-3xl font-bold mb-6 flex items-center gap-2">
        <MapPin className="w-8 h-8 text-blue-600" />
        Property Intelligence Profile
      </h2>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Basic Information */}
        <section>
          <h3 className="text-xl font-semibold mb-4 pb-2 border-b">Basic Information</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Address *
              </label>
              <input
                type="text"
                name="address"
                value={formData.address}
                onChange={handleInputChange}
                placeholder="123 Main St"
                className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              />
              {errors.address && <p className="text-red-600 text-sm mt-1">{errors.address}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                City
              </label>
              <input
                type="text"
                name="city"
                value={formData.city || ''}
                onChange={handleInputChange}
                placeholder="Portland"
                className="w-full px-4 py-2 border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                State
              </label>
              <input
                type="text"
                name="state"
                value={formData.state || ''}
                onChange={handleInputChange}
                placeholder="ME"
                maxLength={2}
                className="w-full px-4 py-2 border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Zip Code
              </label>
              <input
                type="text"
                name="zip_code"
                value={formData.zip_code || ''}
                onChange={handleInputChange}
                placeholder="04101"
                className="w-full px-4 py-2 border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Property Type
              </label>
              <select
                name="property_type"
                value={formData.property_type}
                onChange={handleInputChange}
                className="w-full px-4 py-2 border rounded-lg"
              >
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
                <option value="rental">Rental Turnover</option>
              </select>
            </div>
          </div>
        </section>

        {/* Property Details */}
        <section>
          <h3 className="text-xl font-semibold mb-4 pb-2 border-b">Property Details</h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Square Footage
              </label>
              <input
                type="number"
                name="square_footage"
                value={formData.square_footage || ''}
                onChange={handleInputChange}
                placeholder="2500"
                className="w-full px-4 py-2 border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Bedrooms
              </label>
              <input
                type="number"
                name="bedrooms"
                value={formData.bedrooms || ''}
                onChange={handleInputChange}
                className="w-full px-4 py-2 border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Bathrooms
              </label>
              <input
                type="number"
                name="bathrooms"
                value={formData.bathrooms || ''}
                onChange={handleInputChange}
                className="w-full px-4 py-2 border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Construction Type
              </label>
              <select
                name="construction_type"
                value={formData.construction_type || ''}
                onChange={handleInputChange}
                className="w-full px-4 py-2 border rounded-lg"
              >
                <option value="">Select...</option>
                <option value="carpet">Carpet</option>
                <option value="hardwood">Hardwood</option>
                <option value="tile">Tile</option>
                <option value="mixed">Mixed</option>
                <option value="concrete">Concrete</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Access Type
              </label>
              <select
                name="access_type"
                value={formData.access_type || ''}
                onChange={handleInputChange}
                className="w-full px-4 py-2 border rounded-lg"
              >
                <option value="">Select...</option>
                <option value="entry_code">Entry Code</option>
                <option value="key_pickup">Key Pickup</option>
                <option value="landlord">Landlord</option>
                <option value="tenant">Tenant</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Condition Rating (1-5)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  name="avg_condition_rating"
                  value={formData.avg_condition_rating || ''}
                  onChange={handleInputChange}
                  min={1}
                  max={5}
                  step={0.1}
                  className="w-full px-4 py-2 border rounded-lg"
                />
                {formData.avg_condition_rating && (
                  <span className={`px-3 py-1 rounded text-sm font-medium ${getConditionColor(formData.avg_condition_rating)}`}>
                    {formData.avg_condition_rating <= 2 ? 'Poor' : formData.avg_condition_rating <= 3 ? 'Fair' : 'Good'}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Access Instructions
            </label>
            <textarea
              name="access_instructions"
              value={formData.access_instructions || ''}
              onChange={handleInputChange}
              placeholder="Code: 5432, key hidden under front mat"
              rows={2}
              className="w-full px-4 py-2 border rounded-lg"
            />
          </div>
        </section>

        {/* Safety & Equipment */}
        <section>
          <h3 className="text-xl font-semibold mb-4 pb-2 border-b">Safety & Equipment</h3>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Hazard Notes
              </label>
              <textarea
                name="hazard_notes"
                value={formData.hazard_notes || ''}
                onChange={handleInputChange}
                placeholder="Mold in basement, broken window, asbestos tiles"
                rows={2}
                className="w-full px-4 py-2 border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Pet Alerts
              </label>
              <textarea
                name="pet_alerts"
                value={formData.pet_alerts || ''}
                onChange={handleInputChange}
                placeholder="Large dog on property, cats in basement"
                rows={2}
                className="w-full px-4 py-2 border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Equipment Required
              </label>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {[
                  'carpet_cleaner',
                  'floor_polisher',
                  'pressure_washer',
                  'hepa_vacuum',
                  'window_equipment',
                  'scaffold',
                ].map(equipment => (
                  <label key={equipment} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.equipment_required?.includes(equipment) || false}
                      onChange={() => handleEquipmentToggle(equipment)}
                      className="w-4 h-4 rounded"
                    />
                    <span className="text-sm text-gray-700 capitalize">{equipment.replace(/_/g, ' ')}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Complexity & Estimates */}
        <section className="bg-gray-50 p-4 rounded-lg border">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <TrendingUp className="w-5 h-5" />
              Intelligence Summary
            </h3>
            {complexityScore && (
              <span className={`px-4 py-2 rounded-lg font-bold ${getComplexityColor(complexityScore)}`}>
                Complexity: {complexityScore}/10
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white p-4 rounded border">
              <p className="text-sm text-gray-600 mb-2">Property Type Impact</p>
              <p className="text-lg font-semibold capitalize">
                {formData.property_type === 'rental' && '🔴 Rental Turnover (High Complexity)'}
                {formData.property_type === 'commercial' && '🟡 Commercial (Medium Complexity)'}
                {formData.property_type === 'residential' && '🟢 Residential (Standard)'}
              </p>
            </div>

            {formData.id && (
              <div className="bg-white p-4 rounded border">
                <button
                  type="button"
                  onClick={estimateTime}
                  className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
                >
                  <Clock className="w-4 h-4" />
                  Estimate Clean Time
                </button>
              </div>
            )}
          </div>

          {timeEstimate && (
            <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded">
              <p className="text-sm text-gray-600 mb-1">Estimated Time</p>
              <p className="text-2xl font-bold text-blue-900 mb-2">
                {Math.floor(timeEstimate.estimated_minutes / 60)}h {timeEstimate.estimated_minutes % 60}m
              </p>
              <p className="text-sm text-gray-700">
                <strong>Confidence:</strong> {timeEstimate.confidence} ({timeEstimate.sample_size} historical jobs)
              </p>
              <p className="text-sm text-gray-600 mt-1">{timeEstimate.reasoning}</p>
            </div>
          )}
        </section>

        {/* Photos */}
        <section>
          <h3 className="text-xl font-semibold mb-4 pb-2 border-b flex items-center gap-2">
            <Upload className="w-5 h-5" />
            Property Photos
          </h3>

          <div className="border-2 border-dashed rounded-lg p-6 text-center hover:bg-blue-50 transition">
            <input
              type="file"
              multiple
              accept="image/*"
              onChange={handlePhotoUpload}
              className="hidden"
              id="photo-upload"
            />
            <label htmlFor="photo-upload" className="cursor-pointer">
              <Upload className="w-12 h-12 mx-auto mb-2 text-gray-400" />
              <p className="text-gray-700 font-medium">Drop photos here or click to select</p>
              <p className="text-sm text-gray-500">Reference photos help with better scheduling</p>
            </label>
          </div>

          {photoPreview.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              {photoPreview.map((preview, idx) => (
                <img key={idx} src={preview} alt={`Preview ${idx}`} className="w-full h-24 object-cover rounded-lg" />
              ))}
            </div>
          )}
        </section>

        {/* Error Display */}
        {errors.submit && (
          <div className="p-4 bg-red-50 border border-red-200 rounded flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-red-800">{errors.submit}</p>
          </div>
        )}

        {/* Submit */}
        <div className="flex gap-4">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-400 transition flex items-center justify-center gap-2"
          >
            {loading && <Loader className="w-5 h-5 animate-spin" />}
            {loading ? 'Saving...' : 'Save Property Profile'}
          </button>
        </div>
      </form>
    </div>
  );
}

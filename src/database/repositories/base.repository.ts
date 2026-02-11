import { Model, Document, FilterQuery, UpdateQuery } from 'mongoose';

/**
 * Base repository providing common CRUD operations
 * All specific repositories extend this class
 */
export abstract class BaseRepository<T extends Document> {
  constructor(protected model: Model<T>) {}

  /**
   * Find a single document matching the filter
   */
  async findOne(filter: FilterQuery<T>): Promise<T | null> {
    return await this.model.findOne(filter);
  }

  /**
   * Find a document by its ID
   */
  async findById(id: string): Promise<T | null> {
    return await this.model.findById(id);
  }

  /**
   * Find all documents matching the filter
   */
  async find(filter: FilterQuery<T>): Promise<T[]> {
    return await this.model.find(filter);
  }

  /**
   * Create a new document
   */
  async create(data: Partial<T>): Promise<T> {
    return await this.model.create(data);
  }

  /**
   * Update a document by ID
   */
  async update(id: string, data: UpdateQuery<T>): Promise<T | null> {
    return await this.model.findByIdAndUpdate(id, data, { new: true });
  }

  /**
   * Update a document matching the filter
   */
  async updateOne(filter: FilterQuery<T>, data: UpdateQuery<T>): Promise<T | null> {
    return await this.model.findOneAndUpdate(filter, data, { new: true });
  }

  /**
   * Delete a document by ID
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.model.findByIdAndDelete(id);
    return result !== null;
  }

  /**
   * Delete documents matching the filter
   */
  async deleteMany(filter: FilterQuery<T>): Promise<number> {
    const result = await this.model.deleteMany(filter);
    return result.deletedCount ?? 0;
  }

  /**
   * Count documents matching the filter
   */
  async count(filter: FilterQuery<T>): Promise<number> {
    return await this.model.countDocuments(filter);
  }
}

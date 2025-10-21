export interface Post {
  id: string;
  caption: string;
  imageUrl: string;
  scheduledTime: string;
  createdAt: string;
  status: 'scheduled' | 'posted';
}

export type NewPostInput = Omit<Post, 'id' | 'createdAt' | 'status'>;

"use client";

import { memo } from "react";

export interface AvatarPerson {
  name: string;
  imageUrl?: string | null;
}

/** What a chat's avatar is drawn from. */
export interface ChatFace {
  name: string;
  imageUrl: string | null;
  /** Members of a group, for when it has no photo of its own. */
  members?: AvatarPerson[];
}

interface AvatarProps {
  /** Shown as an initial when there is no picture. */
  name: string;
  imageUrl?: string | null;
  /**
   * For a group without a photo of its own: its members. The first two are
   * shown overlapping, the way Messages draws an unnamed group.
   */
  members?: AvatarPerson[];
  size?: number;
}

function initial(name: string): string {
  const first = name.charAt(0);
  return /[a-zA-Z]/.test(first) ? first.toUpperCase() : "#";
}

function Face({ person, size }: { person: AvatarPerson; size: number }) {
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {person.imageUrl ? <img src={person.imageUrl} alt="" draggable={false} /> : initial(person.name)}
    </div>
  );
}

export const Avatar = memo(function Avatar({ name, imageUrl, members, size = 48 }: AvatarProps) {
  if (!imageUrl && members && members.length >= 2) {
    const small = Math.round(size * 0.64);
    return (
      <div className="avatar-cluster" style={{ width: size, height: size }}>
        <div className="avatar-cluster-back">
          <Face person={members[0]} size={small} />
        </div>
        <div className="avatar-cluster-front">
          <Face person={members[1]} size={small} />
        </div>
      </div>
    );
  }
  return <Face person={{ name, imageUrl }} size={size} />;
});

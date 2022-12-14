import { Injectable } from "@nestjs/common";
import { MailerService } from "src/external/mailer.service";
import { PrismaService } from "src/external/prisma.service";
import { RedisService } from "src/external/redis.service";
import { keys } from "src/keys";
import { IOrganizationService } from "./organization.service.interface";
import * as otp from "otp-generator";
import * as bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { User } from "@prisma/client";

@Injectable()
export class OrganizationService implements IOrganizationService {

    constructor(
        private readonly _prismaService: PrismaService,
        private readonly _mailerService: MailerService,
        private readonly _redisService: RedisService

    ) { }

    async addUser(email: string, name: string, password: string, organizationID: string, roles: Array<string>) {
        let orguser = await this._prismaService.organizationUser.create({
            data: {
                user: {
                    create: {
                        email: email,
                        authData: {
                            password: password
                        },
                        profileData: {
                            firstname: name
                        }
                    }
                },
                organization: {
                    connect: {
                        id: organizationID
                    }
                },
                isAdmin: false,
                roles: {
                    createMany: {
                        data: roles.map((role: string) => ({ name: role }))
                    }
                }
            }
        });
        return orguser
    }

    async inviteUser(email: string, name: string, organizationID: string, roles: Array<string>) {
        let user = await this._prismaService.user.findUnique({ where: { email: email } });
        let organization = await this._prismaService.organization.findUnique({ where: { id: organizationID } });
        if (!organization) {
            throw new Error("no organization exists");
        }
        let newUser = false;

        if (user) {
            let orgUser = await this._prismaService.organizationUser.findFirst({ where: { organizationID: organization.id, userID: user.id } });
            if (orgUser) {
                throw new Error("already part of organization");
            }
        }

        if (!user) {
            newUser = true;
        }

        let code = otp.generate(6, { lowerCaseAlphabets: false, specialChars: false, digits: true, upperCaseAlphabets: true });
        await this._mailerService.sendEmail(email, `Invitation: You've been invited to join ${organization.name}`, `
            <p>Hi ${name},</p>
            <p>You've been invited to join ${organization.name}</p>
            <p>If you want to join please press the link <a href="${keys.REDIRECT_URL}/join?user=${email}&org=${organizationID}&newuser=${newUser}&code=${code}&name=${name}">here</a></p>
            <p>Thanks,</p>
            <p>${keys.ORG_NAME}.</p>
        `)
        await this._redisService.client.set(`invite:${organizationID}-${email}`, JSON.stringify({ code: code, name: name, newuser: newUser, roles: roles }), { EX: keys.CODE_EXPIRY });
        return true;
    }

    async acceptInvitation(email: string, organizationID: string, code: string, password: string | null) {

        let inviteData = await this._redisService.client.get(`invite:${organizationID}-${email}`);

        let invite = JSON.parse(inviteData);

        if (!invite || !invite.code || invite.code !== code) {
            throw new Error("unable to verify code");
        }

        let user: User | null = null;

        if (!invite.newuser) {
            user = await this._prismaService.user.findUnique({ where: { email: email } });
        }

        if (invite.newuser) {

            let hashpass = await bcrypt.hash(password, 10);

            user = await this._prismaService.user.create({
                data: {
                    email: email,
                    authData: {
                        password: hashpass
                    },
                    profileData: {
                        firstname: invite.name,
                        lastname: "",
                        status: "verified",
                    }
                }
            })
        }

        await this._prismaService.organizationUser.create({
            data: {
                userID: user.id,
                organizationID: organizationID,
                isAdmin: false,
                roles: {
                    createMany: {
                        data: invite.roles.map((role: string) => ({ name: role }))
                    }
                }
            }
        });

        await this._redisService.client.del(`invite:${organizationID}-${email}`);

        return true;
    }

    async fetchOrganizationUsers(organizationID: string) {

        let organizationUsers = await this._prismaService.organizationUser.findMany({
            where: {
                organizationID: organizationID
            },
            include: {
                user: {
                    select: {
                        email: true,
                        profileData: true
                    }
                },
            }
        });

        return organizationUsers;
    }

    async createOrganization(adminID: string, name: string) {

        let identifier = `${name}-${randomBytes(6).toString("hex")}`

        await this._prismaService.organizationUser.create({
            data: {
                user: {
                    connect: {
                        id: adminID
                    }
                },
                isAdmin: true,
                organization: {
                    create: {
                        name: name,
                        identifier: identifier
                    }
                }
            }
        });

        return true;
    }

    async assignRole(userID: string, organizationID: string, roleName: string) {

        let user = await this._prismaService.organizationUser.findFirst({ where: { userID: userID, organizationID: organizationID } });

        if (!user) {
            throw new Error("user not present in organization")
        }

        await this._prismaService.role.create({
            data: {
                name: roleName,
                organizationUserID: user.id
            }
        });

        return true;

    }

    async deleteRole(userID: string, organizationID: string, roleName: string) {

        let user = await this._prismaService.organizationUser.findFirst({ where: { userID: userID, organizationID: organizationID } });

        if (!user) {
            throw new Error("user not present in organization")
        }

        await this._prismaService.role.deleteMany({
            where: {
                name: roleName,
                organizationUserID: user.id
            }
        });

        return true;
    }

    async leaveOrganization(userID: string, organizationID: string) {

        let user = await this._prismaService.organizationUser.findFirst({ where: { userID: userID, organizationID: organizationID } });

        if (!user) {
            throw new Error("you are not part of this organization");
        }

        if (user.isAdmin) {

            let admins = await this._prismaService.organizationUser.findMany({ where: { isAdmin: true, organizationID: organizationID } });

            if (admins.length === 1) {
                throw new Error("admin cannot leave organization")
            }

        }

        await this._prismaService.organizationUser.delete({ where: { id: user.id } });

        return true;
    }

    async deleteOrganization(organizationID: string) {

        await this._prismaService.organization.delete({
            where: {
                id: organizationID
            },
            include: {
                users: {
                    include: {
                        roles: true
                    }
                }
            }
        });

        return true;
    }

}
